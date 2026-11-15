import {
  buildRelayTransport,
  cloudAlertsFor,
  createCloudAlerter,
  createEngine,
  hostnames,
  selectTransport,
  type CdpClient,
  type Engine,
  type LinkInfo,
  type PopupSource,
  type TransportChoice,
} from '@velmlabs/unstuck-core';
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import { attachPage, PageClosedError, type AttachedPage } from './attach';
import { startKeepAlive, toCdpClient } from './cdp-adapter';
import { UnstuckConfigError } from './errors';
import { optionEnv, validateOptions, type TakeoverLink, type TakeoverOptions, type UnstuckOptions } from './options';
import { VERSION } from './version';

// Workers have no stderr. Never prints a 6-digit code: requireCode needs its own onLink.
const defaultOnLink = (l: TakeoverLink) => console.log(`Unstuck: a human is needed (${l.reason}) → ${l.url}`);

/** Playwright and Puppeteer pages are event emitters that emit 'popup' with the new page (attachPage needs `on`). */
type PageEvents = { on(e: string, cb: (p: unknown) => void): unknown; off?(e: string, cb: (p: unknown) => void): unknown };

function siteOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Unstuck running core's engine in this JavaScript runtime (Workers, or `mode: 'in-process'` on Node). */
export class InProcessUnstuck {
  private readonly env: Record<string, string | undefined>;
  private readonly choice: TransportChoice;
  private readonly alerter: ((info: LinkInfo, site: string | undefined) => Promise<void>) | null;
  private engine: Engine | null = null;
  /** Bumped by close(): a takeover that was still attaching when it ran must not start a new engine. */
  private generation = 0;
  private readonly inFlight = new Set<Promise<TakeoverResult>>();

  constructor(
    private readonly opts: UnstuckOptions,
    env: Record<string, string | undefined>,
  ) {
    validateOptions(opts);
    this.env = { ...env, ...optionEnv(opts) };
    this.choice = selectTransport({}, this.env);
    const cloud = cloudAlertsFor(this.choice, this.env);
    this.alerter = cloud ? createCloudAlerter({ ...cloud, fetch: opts.fetch }) : null;
  }

  async takeover(page: unknown, o: TakeoverOptions): Promise<TakeoverResult> {
    const run = this.run(page, o);
    this.inFlight.add(run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(run);
    }
  }

  private async run(page: unknown, o: TakeoverOptions): Promise<TakeoverResult> {
    if (this.choice.kind !== 'relay') throw new UnstuckConfigError('in a Worker, Unstuck needs a relay: set apiKey or relay + agentKey');
    const requireCode = o.requireCode ?? this.opts.requireCode ?? this.env.UNSTUCK_REQUIRE_CODE === '1';
    if (requireCode && !this.opts.onLink)
      throw new TypeError('requireCode needs an onLink handler that sends the 6-digit code by a different channel than the link (printed together, the code protects nothing)');
    const generation = this.generation;
    let attached: AttachedPage;
    try {
      attached = await attachPage(page);
    } catch (e) {
      if (e instanceof PageClosedError) return { status: 'failed', sessionId: '', url: '', durationS: 0, detail: 'page_closed' };
      throw e;
    }
    if (generation !== this.generation) {
      // close() ran while the page was attaching: cancelled like the takeovers it ended (core's engine_closed shape).
      await attached.detach();
      return { status: 'cancelled', sessionId: '', url: '', durationS: 0, detail: 'engine_closed' };
    }
    const cdp = toCdpClient(attached);
    const stopKeepAlive = startKeepAlive(cdp);
    const popups: AttachedPage[] = [];
    const popupCbs = new Set<(popup: CdpClient) => void>();
    let ended = false;
    // Follow popups (e.g. a CAPTCHA provider's window) while the human is in control.
    const onPopup = async (popupPage: unknown) => {
      try {
        const popup = await attachPage(popupPage);
        // Attached after the takeover ended: nobody follows it any more.
        if (ended) return void (await popup.detach());
        popups.push(popup);
        const client = toCdpClient(popup);
        for (const cb of [...popupCbs]) cb(client);
      } catch {
        // a popup that closes before we can attach is simply not followed
      }
    };
    const source: PopupSource = {
      onPopup(cb) {
        popupCbs.add(cb);
        return () => void popupCbs.delete(cb);
      },
    };
    const events = page as PageEvents;
    events.on('popup', onPopup);
    const site = siteOf(attached.url());
    const onLink = this.opts.onLink ?? defaultOnLink;
    try {
      return await this.ensureEngine().takeover(cdp, {
        reason: o.reason,
        timeoutS: o.timeoutS ?? this.opts.timeoutS,
        site,
        requireCode,
        allowedSites: hostnames(o.allowedSites),
        popups: source,
        onLink: (info) => {
          onLink({ url: info.url, reason: info.reason, sessionId: info.sessionId, expiresAt: info.expiresAt, ...(info.code ? { code: info.code } : {}) });
          if (o.alerts !== false) void this.alerter?.(info, site);
        },
      });
    } finally {
      ended = true;
      stopKeepAlive();
      events.off?.('popup', onPopup);
      for (const popup of popups) await popup.detach();
      await attached.detach();
    }
  }

  /**
   * Cancels running takeovers (`engine_closed`), also those still attaching their page, closes the relay sockets and
   * resolves once they have all ended. A later takeover starts a new engine.
   */
  async close(): Promise<void> {
    this.generation++;
    const engine = this.engine;
    this.engine = null;
    await engine?.close();
    await Promise.allSettled([...this.inFlight]);
  }

  private ensureEngine(): Engine {
    // Only called once the choice is a relay.
    const choice = this.choice as Extract<TransportChoice, { kind: 'relay' }>;
    this.engine ??= createEngine({ transport: buildRelayTransport(choice, { env: this.env, version: VERSION, warn: (l) => console.error(l) }) });
    return this.engine;
  }
}
