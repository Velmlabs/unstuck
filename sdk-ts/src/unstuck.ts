import {
  Methods,
  RpcCallError,
  type CdpSendParams,
  type CdpSubscribeParams,
  type PageCloseParams,
  type PageCreateParams,
  type PaintCheckResult,
  type TakeoverLinkParams,
  type TakeoverParams,
  type TakeoverResult,
} from '@velmlabs/unstuck-protocol';
import { createFileSessionStore, onceRenderCheck, profileFile, type RenderCheck } from '@velmlabs/unstuck-core';
import { attachPage, PageClosedError, type AttachedPage } from './attach';
import { adapterFor, createWrap } from './browser/wrap';
import { nodeStoreFs, unstuckHome } from './browser/node-store-fs';
import type { WrapOptions, Wrapped } from './browser/options';
import { resolveEnginePath, spawnEngine, type EngineProcess } from './engine-process';
import { UnstuckConfigError, UnstuckEngineError } from './errors';
import { InProcessUnstuck } from './in-process';
import { callUserOnLink, optionEnv, validateOptions, type TakeoverLink, type TakeoverOptions, type UnstuckOptions } from './options';

export type { TakeoverLink, UnstuckOptions };

// Never prints a 6-digit code: requireCode needs its own onLink, so the code travels apart from the link.
const defaultOnLink = (l: TakeoverLink) => process.stderr.write(`Unstuck: a human is needed (${l.reason}) → ${l.url}\n`);

/** Playwright and Puppeteer pages are event emitters that emit 'popup' with the new page. */
function pageEvents(page: unknown): { on(e: string, cb: (p: unknown) => void): unknown; off?(e: string, cb: (p: unknown) => void): unknown } | null {
  const p = page as { on?: unknown };
  return typeof p?.on === 'function' ? (page as never) : null;
}

function siteOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

export class Unstuck {
  private engine: Promise<EngineProcess> | null = null;
  private readonly pages = new Map<string, AttachedPage>();
  private inFlight = 0;
  /** Set for `mode: 'in-process'`: every method delegates to it. */
  private readonly inProcess: InProcessUnstuck | null;
  /** Pages the engine may open a probe tab next to (browser.paintCheck → page.create), by pageId. */
  private readonly openers = new Map<string, unknown>();
  /** Probe tabs the engine opened, so page.close can close them. */
  private readonly probes = new Map<string, unknown>();
  /** One paint check per browser (binary mode). */
  private readonly renderChecks = new WeakMap<object, RenderCheck>();
  private readonly browserIds = new WeakMap<object, string>();
  private nextOpener = 0;
  private readonly wrapper = createWrap({
    takeover: (page, o) => this.takeover(page, o),
    store: (profile) => createFileSessionStore(nodeStoreFs(), profileFile(unstuckHome(), profile)),
    renderCheck: (page) => (this.inProcess ? undefined : this.renderCheckFor(page)),
  });

  constructor(private readonly opts: UnstuckOptions = {}) {
    validateOptions(opts);
    // On Node, the environment is the fallback for options, exactly like binary mode.
    this.inProcess = opts.mode === 'in-process' ? new InProcessUnstuck(opts, process.env, 'in-process mode needs a relay: set apiKey or relay + agentKey') : null;
  }

  /**
   * Pauses your agent until a human finishes. Awaiting this IS the pause: don't drive the page meanwhile.
   * Resolves with the outcome; rejects only with UnstuckEngineError if the engine can't run.
   */
  async takeover(
    page: unknown,
    opts: TakeoverOptions,
  ): Promise<TakeoverResult> {
    if (this.inProcess) return this.inProcess.takeover(page, opts);
    // The engine also asks for a code when UNSTUCK_REQUIRE_CODE=1 (it inherits this environment).
    if ((opts.requireCode ?? this.opts.requireCode ?? process.env.UNSTUCK_REQUIRE_CODE === '1') && !this.opts.onLink)
      throw new TypeError('requireCode needs an onLink handler that sends the 6-digit code by a different channel than the link (printed together, the code protects nothing)');
    const pageClosed: TakeoverResult = { status: 'failed', sessionId: '', url: '', durationS: 0, detail: 'page_closed' };
    let attached: AttachedPage;
    try {
      attached = await attachPage(page);
    } catch (e) {
      if (e instanceof PageClosedError) return pageClosed;
      throw e;
    }
    let engine: EngineProcess | undefined;
    const popups: AttachedPage[] = [];
    let onPopup: ((p: unknown) => void) | null = null;
    // Watch for close from the start: the page can go away while the engine is still starting.
    let closedEarly = false;
    let notifyClose: ((reason: string) => void) | null = null;
    let wakeOnClose!: () => void;
    const closedWhileStarting = new Promise<null>((r) => (wakeOnClose = () => r(null)));
    attached.onClose((reason) => {
      if (notifyClose) notifyClose(reason);
      else {
        closedEarly = true;
        wakeOnClose();
      }
    });
    try {
      engine = (await Promise.race([this.ensureEngine(), closedWhileStarting])) ?? undefined;
      if (closedEarly || !engine) return pageClosed;
      const live = engine;
      this.pages.set(attached.pageId, attached);
      notifyClose = (reason) => live.peer.notify(Methods.cdpClosed, { pageId: attached.pageId, reason });
      // Follow popups (e.g. a CAPTCHA provider's window) while the human is in control.
      onPopup = async (popupPage: unknown) => {
        try {
          const popup = await attachPage(popupPage);
          popups.push(popup);
          this.pages.set(popup.pageId, popup);
          popup.onClose((reason) => live.peer.notify(Methods.cdpClosed, { pageId: popup.pageId, reason }));
          live.peer.notify(Methods.pagePopup, { pageId: attached.pageId, popupPageId: popup.pageId });
        } catch {
          // a popup that closes before we can attach is simply not followed
        }
      };
      pageEvents(page)?.on('popup', onPopup);
      engine.setBusy(++this.inFlight > 0);
      const requireCode = opts.requireCode ?? this.opts.requireCode;
      const params: TakeoverParams = {
        pageId: attached.pageId,
        reason: opts.reason,
        timeoutS: opts.timeoutS ?? this.opts.timeoutS,
        site: siteOf(attached.url()),
        ...(requireCode !== undefined ? { requireCode } : {}),
        ...(opts.allowedSites?.length ? { allowedSites: opts.allowedSites } : {}),
        ...(opts.alerts !== undefined ? { alerts: opts.alerts } : {}),
      };
      const died = engine.exited.then((code): never => {
        throw new UnstuckEngineError(`engine exited with code ${code}`);
      });
      died.catch(() => {});
      try {
        return await Promise.race([engine.peer.request<TakeoverResult>(Methods.takeover, params), died]);
      } catch (e) {
        // The RPC channel closing means the engine process is gone; report it as such.
        if (e instanceof RpcCallError && e.code === 'closed') throw new UnstuckEngineError(`engine exited with code ${await engine.exited}`);
        // The engine refused the options (e.g. alerts: 'required' without Unstuck Cloud).
        if (e instanceof RpcCallError && e.code === 'config_error') throw new UnstuckConfigError(e.message);
        throw e;
      }
    } finally {
      if (onPopup) pageEvents(page)?.off?.('popup', onPopup);
      for (const popup of popups) {
        this.pages.delete(popup.pageId);
        await popup.detach();
      }
      this.pages.delete(attached.pageId);
      await attached.detach();
      if (engine && notifyClose) engine.setBusy(--this.inFlight > 0);
    }
  }

  /**
   * Guards a Playwright page: navigations and clicks that land on a human check (a CAPTCHA, Cloudflare's "verify you
   * are human") bring a person in and return once they're past it. Returns the same page, with `page.unstuck`.
   */
  wrap<P extends object>(page: P, o?: WrapOptions): Wrapped<P> {
    return this.wrapper(page, o);
  }

  /** browser.paintCheck when the engine offers it; 'unknown' (go ahead) from an older engine. */
  private renderCheckFor(page: unknown): RenderCheck {
    const browser = adapterFor(page).browserKey(page);
    let check = this.renderChecks.get(browser);
    if (!check) {
      let id = this.browserIds.get(browser);
      if (!id) this.browserIds.set(browser, (id = `browser-${this.nextOpener++}`));
      const browserKey = id;
      check = onceRenderCheck(async () => {
        const engine = await this.ensureEngine();
        if (!engine.capabilities.includes('paintCheck')) return 'unknown';
        const pageId = `opener-${this.nextOpener++}`;
        this.openers.set(pageId, page);
        try {
          return (await engine.peer.request<PaintCheckResult>(Methods.paintCheck, { pageId, browserKey })).paint;
        } finally {
          this.openers.delete(pageId);
        }
      });
      this.renderChecks.set(browser, check);
    }
    return check;
  }

  /** Stops the engine (cancelling any running takeover). */
  async close(): Promise<void> {
    if (this.inProcess) return this.inProcess.close();
    const pending = this.engine;
    this.engine = null;
    if (!pending) return;
    const engine = await pending.catch(() => null);
    if (!engine) return;
    engine.setBusy(true);
    engine.peer.request(Methods.shutdown, {}).catch(() => {});
    const timer = setTimeout(() => engine.kill(), 2000);
    await engine.exited;
    clearTimeout(timer);
  }

  private ensureEngine(): Promise<EngineProcess> {
    if (this.engine) return this.engine;
    const started = (async () => {
      const engine = await spawnEngine(resolveEnginePath(this.opts), { host: this.opts.host, port: this.opts.port, env: { ...process.env, ...optionEnv(this.opts) } });
      engine.peer.handle(Methods.cdpSend, (raw) => {
        const p = raw as CdpSendParams;
        const page = this.pages.get(p.pageId);
        if (!page) throw new Error(`unknown page ${p.pageId}`);
        return page.send(p.method, p.params);
      });
      engine.peer.handle(Methods.cdpSubscribe, (raw) => {
        const p = raw as CdpSubscribeParams;
        const page = this.pages.get(p.pageId);
        if (!page) throw new Error(`unknown page ${p.pageId}`);
        for (const event of p.events) page.subscribe(event, (params) => engine.peer.notify(Methods.cdpEvent, { pageId: p.pageId, method: event, params }));
        return {};
      });
      engine.peer.handle(Methods.pageCreate, async (raw) => {
        const opener = this.openers.get((raw as PageCreateParams).pageId);
        if (!opener) throw new Error(`unknown page ${(raw as PageCreateParams).pageId}`);
        const tab = await adapterFor(opener).newPage(opener);
        const attached = await attachPage(tab);
        this.pages.set(attached.pageId, attached);
        this.probes.set(attached.pageId, tab);
        return { pageId: attached.pageId };
      });
      engine.peer.handle(Methods.pageClose, async (raw) => {
        const { pageId } = raw as PageCloseParams;
        const tab = this.probes.get(pageId);
        const attached = this.pages.get(pageId);
        if (!tab || !attached) throw new Error(`unknown page ${pageId}`);
        this.probes.delete(pageId);
        this.pages.delete(pageId);
        await attached.detach();
        await (tab as { close(): Promise<void> }).close();
        return {};
      });
      engine.peer.onNotification(Methods.takeoverLink, (raw) => {
        const l = raw as TakeoverLinkParams;
        const link: TakeoverLink = { url: l.url, reason: l.reason, sessionId: l.sessionId, expiresAt: l.expiresAt, ...(l.code ? { code: l.code } : {}) };
        // A throwing handler would escape the engine's stdout reader and crash the process.
        if (this.opts.onLink) callUserOnLink(this.opts.onLink, link);
        else defaultOnLink(link);
      });
      void engine.exited.then(() => {
        if (this.engine === started) this.engine = null;
      });
      return engine;
    })();
    this.engine = started;
    started.catch(() => {
      if (this.engine === started) this.engine = null;
    });
    return started;
  }
}
