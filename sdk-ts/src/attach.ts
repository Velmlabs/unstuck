/** A CDP session on the developer's page, regardless of automation library. */
export interface AttachedPage {
  pageId: string;
  url(): string;
  send(method: string, params?: object): Promise<unknown>;
  subscribe(event: string, cb: (params: unknown) => void): void;
  onClose(cb: (reason: string) => void): void;
  detach(): Promise<void>;
}

interface CdpSessionLike {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, cb: (params: unknown) => void): unknown;
  detach(): Promise<unknown>;
}
interface PageLike {
  on(event: string, cb: () => void): unknown;
  off?(event: string, cb: () => void): unknown;
  url?(): string;
}
/** Node-style and Puppeteer-style event emitters (Puppeteer's have `off`, Node's also `removeListener`). */
interface EmitterLike {
  on?(event: string, cb: () => void): unknown;
  off?(event: string, cb: () => void): unknown;
  removeListener?(event: string, cb: () => void): unknown;
}

/** Older Puppeteer names the session's disconnect event with a string; current Puppeteer uses a symbol of this description. */
const SESSION_DISCONNECTED = ['CDPSession.Disconnected', 'Disconnected'];
const SESSION_DISCONNECTED_SYMBOL = 'CDPSession.Disconnected';

/** Listens on an emitter that may not exist; returns how to stop. */
function listen(target: EmitterLike | null | undefined, event: string, cb: () => void): () => void {
  if (!target || typeof target.on !== 'function') return () => {};
  target.on(event, cb);
  return () => void (target.off ?? target.removeListener)?.call(target, event, cb);
}

/**
 * Calls `cb` when the session emits Puppeteer's `CDPSessionEvent.Disconnected` symbol. The symbol is not registered
 * (`Symbol()`, not `Symbol.for()`), so it can't be subscribed to without importing Puppeteer: the session's own `emit`
 * is wrapped instead, and put back by the returned function.
 */
function onSymbolDisconnect(session: object, cb: () => void): () => void {
  const s = session as { emit?: (type: unknown, ...rest: unknown[]) => unknown };
  const original = s.emit;
  if (typeof original !== 'function') return () => {};
  const own = Object.prototype.hasOwnProperty.call(s, 'emit');
  const wrapped = function (this: unknown, type: unknown, ...rest: unknown[]) {
    if (typeof type === 'symbol' && type.description === SESSION_DISCONNECTED_SYMBOL) cb();
    return original.call(this, type, ...rest);
  };
  s.emit = wrapped;
  return () => {
    if (s.emit !== wrapped) return; // someone wrapped it after us: leave theirs in place
    if (own) s.emit = original;
    else delete s.emit;
  };
}

/** The page was already closed when Unstuck tried to attach. */
export class PageClosedError extends Error {
  constructor() {
    super('page closed');
    this.name = 'PageClosedError';
  }
}

let counter = 0;
const newPageId = () => `page-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Opens a CDP session on a Playwright or Puppeteer Page. */
export async function attachPage(page: unknown): Promise<AttachedPage> {
  const p = page as Record<string, any> | null;
  const isPlaywright = !!p && typeof p.context === 'function' && typeof p.context()?.newCDPSession === 'function';
  const isPuppeteer = !!p && typeof p.createCDPSession === 'function';
  if (!isPlaywright && !isPuppeteer) throw new TypeError('Unsupported page object: pass a Playwright or Puppeteer Page');
  const isClosed = () => (typeof p!.isClosed === 'function' ? Boolean(p!.isClosed()) : false);
  if (isClosed()) throw new PageClosedError();
  let session: CdpSessionLike;
  try {
    session = isPlaywright ? await p!.context().newCDPSession(p) : await p!.createCDPSession();
  } catch (e) {
    if (isClosed()) throw new PageClosedError();
    throw e;
  }
  const pageObj = p as unknown as PageLike;
  const closeCbs: ((reason: string) => void)[] = [];
  let closedReason: string | null = null;
  const fire = (reason: string) => () => {
    if (closedReason !== null) return;
    closedReason = reason;
    for (const cb of closeCbs) cb(reason);
  };
  const onPageClose = fire('page closed');
  const onCrash = fire('page crashed');
  pageObj.on('close', onPageClose);
  pageObj.on('crash', onCrash);
  // A dropped browser connection never fires the page's 'close' (e.g. Cloudflare Browser Rendering going away).
  const onDisconnect = fire('browser disconnected');
  const browser = (isPlaywright ? p!.context().browser?.() : p!.browser?.()) as EmitterLike | null | undefined;
  const offDisconnect = [
    ...SESSION_DISCONNECTED.map((event) => listen(session as EmitterLike, event, onDisconnect)),
    onSymbolDisconnect(session, onDisconnect),
    listen(browser, 'disconnected', onDisconnect),
  ];

  return {
    pageId: newPageId(),
    url: () => pageObj.url?.() ?? '',
    send: (method, params) => session.send(method, params),
    subscribe: (event, cb) => void session.on(event, cb),
    onClose: (cb) => {
      if (closedReason !== null) cb(closedReason);
      else closeCbs.push(cb);
    },
    async detach() {
      pageObj.off?.('close', onPageClose);
      pageObj.off?.('crash', onCrash);
      for (const off of offDisconnect) off();
      await session.detach().catch(() => {});
    },
  };
}
