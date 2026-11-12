import {
  Methods,
  RpcCallError,
  type CdpSendParams,
  type CdpSubscribeParams,
  type TakeoverLinkParams,
  type TakeoverParams,
  type TakeoverResult,
} from '@unstuck/protocol';
import { attachPage, type AttachedPage } from './attach';
import { resolveEnginePath, spawnEngine, type EngineProcess } from './engine-process';
import { UnstuckEngineError } from './errors';

export interface TakeoverLink {
  url: string;
  reason: string;
  sessionId: string;
  expiresAt: number;
}

export interface UnstuckOptions {
  enginePath?: string;
  host?: string;
  port?: number;
  /** Default takeover timeout in seconds (engine default: 600). */
  timeoutS?: number;
  /** Called when a human is needed. Default: print the link to stderr. */
  onLink?: (link: TakeoverLink) => void;
}

const defaultOnLink = (l: TakeoverLink) => process.stderr.write(`Unstuck: a human is needed (${l.reason}) → ${l.url}\n`);

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

  constructor(private readonly opts: UnstuckOptions = {}) {}

  /**
   * Pauses your agent until a human finishes. Awaiting this IS the pause: don't drive the page meanwhile.
   * Resolves with the outcome; rejects only with UnstuckEngineError if the engine can't run.
   */
  async takeover(page: unknown, opts: { reason: string; timeoutS?: number }): Promise<TakeoverResult> {
    const attached = await attachPage(page);
    let engine: EngineProcess | undefined;
    try {
      engine = await this.ensureEngine();
      this.pages.set(attached.pageId, attached);
      attached.onClose((reason) => engine!.peer.notify(Methods.cdpClosed, { pageId: attached.pageId, reason }));
      engine.setBusy(++this.inFlight > 0);
      const params: TakeoverParams = { pageId: attached.pageId, reason: opts.reason, timeoutS: opts.timeoutS ?? this.opts.timeoutS, site: siteOf(attached.url()) };
      const died = engine.exited.then((code): never => {
        throw new UnstuckEngineError(`engine exited with code ${code}`);
      });
      died.catch(() => {});
      try {
        return await Promise.race([engine.peer.request<TakeoverResult>(Methods.takeover, params), died]);
      } catch (e) {
        // The RPC channel closing means the engine process is gone; report it as such.
        if (e instanceof RpcCallError && e.code === 'closed') throw new UnstuckEngineError(`engine exited with code ${await engine.exited}`);
        throw e;
      }
    } finally {
      this.pages.delete(attached.pageId);
      await attached.detach();
      if (engine) engine.setBusy(--this.inFlight > 0);
    }
  }

  /** Stops the engine (cancelling any running takeover). */
  async close(): Promise<void> {
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
      const engine = await spawnEngine(resolveEnginePath(this.opts), { host: this.opts.host, port: this.opts.port });
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
      engine.peer.onNotification(Methods.takeoverLink, (raw) => {
        const l = raw as TakeoverLinkParams;
        (this.opts.onLink ?? defaultOnLink)({ url: l.url, reason: l.reason, sessionId: l.sessionId, expiresAt: l.expiresAt });
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
