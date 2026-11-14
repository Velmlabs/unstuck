import { WebSocket } from 'ws';
import type { CdpClient, PopupSource } from '@velmlabs/unstuck-core';

/** Browser-level CDP access (no session), e.g. for Target.* discovery. */
export interface BrowserCdp {
  send<T = unknown>(method: string, params?: object): Promise<T>;
  on(event: string, handler: (params: any) => void): () => void;
}

export interface DirectCdp extends CdpClient {
  targetId: string;
  browser: BrowserCdp;
  /** Popups this target opens, already attached over the same connection. */
  popups: PopupSource;
  /** Detaches and closes the browser connection (never closes the browser or the tab). */
  close(): Promise<void>;
}

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  attached: boolean;
  openerId?: string;
}

/** Accepts http(s)://host:port, host:port, or ws(s)://…/devtools/browser/<id>. */
export function normalizeCdpUrl(input: string): string {
  const s = input.trim();
  if (/^wss?:\/\//.test(s)) return s;
  if (/^https?:\/\//.test(s)) return s.replace(/\/+$/, '');
  if (/^[A-Za-z0-9.-]+:\d+$/.test(s) || /^\[[0-9a-f:]+\]:\d+$/i.test(s)) return `http://${s}`;
  throw new Error(`not a CDP URL: ${JSON.stringify(input)} (expected http://host:port, host:port or ws://…/devtools/browser/<id>)`);
}

export function pickTarget(targets: TargetInfo[], targetId?: string): TargetInfo {
  if (targetId) {
    const t = targets.find((x) => x.targetId === targetId);
    if (!t) throw new Error(`target ${targetId} not found`);
    return t;
  }
  const page = targets.find((x) => x.type === 'page' && !x.url.startsWith('devtools://'));
  if (!page) throw new Error('no page target to take over');
  return page;
}

async function resolveWsUrl(url: string, fetchImpl: typeof fetch): Promise<string> {
  if (url.startsWith('ws')) return url;
  let res: Response;
  try {
    res = await fetchImpl(`${url}/json/version`);
  } catch (e) {
    throw new Error(`could not reach the browser at ${url}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`could not reach the browser at ${url}: HTTP ${res.status}`);
  const v = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!v.webSocketDebuggerUrl) throw new Error(`the browser at ${url} did not report a webSocketDebuggerUrl`);
  return v.webSocketDebuggerUrl;
}

type Handlers = Map<string, Set<(p: any) => void>>;

const addHandler = (map: Handlers, event: string, h: (p: any) => void) => {
  const set = map.get(event) ?? new Set();
  set.add(h);
  map.set(event, set);
  return () => void set.delete(h);
};

/** A browser-level connection with no page attached (e.g. to open a tab of our own). */
export async function connectBrowser(url: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<BrowserCdp & { close(): Promise<void> }> {
  const ws = new WebSocket(await resolveWsUrl(normalizeCdpUrl(url), opts.fetchImpl ?? fetch), { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(new Error(`could not reach the browser at ${url}: ${e.message}`)));
  });
  let nextId = 1;
  let disconnected: string | null = null;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const handlers: Handlers = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: any; sessionId?: string };
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
    } else if (msg.method && !msg.sessionId) for (const h of [...(handlers.get(msg.method) ?? [])]) h(msg.params);
  });
  ws.on('close', () => {
    disconnected = 'browser disconnected';
    for (const p of pending.values()) p.reject(new Error(disconnected));
    pending.clear();
  });
  return {
    send<T>(method: string, params?: object): Promise<T> {
      if (disconnected !== null) return Promise.reject(new Error(disconnected));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      });
    },
    on: (e, h) => addHandler(handlers, e, h),
    async close() {
      if (ws.readyState !== WebSocket.OPEN) return;
      const closed = new Promise((r) => ws.once('close', r));
      ws.close();
      await closed;
    },
  };
}

interface Session {
  id: string;
  targetId: string;
  handlers: Handlers;
  closeHandlers: Set<(reason: string) => void>;
  closedReason: string | null;
}


/** Connects straight to a browser's DevTools endpoint and attaches to one page target. */
export async function connectCdp(
  url: string,
  opts: { targetId?: string; createUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<DirectCdp> {
  const ws = new WebSocket(await resolveWsUrl(normalizeCdpUrl(url), opts.fetchImpl ?? fetch), { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(new Error(`could not reach the browser at ${url}: ${e.message}`)));
  });

  let nextId = 1;
  let disconnected: string | null = null;
  let closingOurselves = false;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; sid?: string }>();
  const browserHandlers: Handlers = new Map();
  const sessions = new Map<string, Session>();

  const fireClose = (s: Session, reason: string) => {
    if (s.closedReason !== null) return;
    s.closedReason = reason;
    // Chrome may never answer commands sent to a target that is gone: fail them now.
    for (const [id, p] of pending) {
      if (p.sid !== s.id) continue;
      pending.delete(id);
      p.reject(new Error(reason));
    }
    for (const h of [...s.closeHandlers]) h(reason);
  };

  const raw = <T>(method: string, params: object | undefined, sid?: string): Promise<T> => {
    if (disconnected !== null) return Promise.reject(new Error(disconnected));
    const closed = sid ? sessions.get(sid)?.closedReason : null;
    if (closed) return Promise.reject(new Error(closed));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject, sid });
      ws.send(JSON.stringify({ id, method, params: params ?? {}, ...(sid ? { sessionId: sid } : {}) }));
    });
  };

  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: any; sessionId?: string };
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    if (msg.sessionId) {
      const s = sessions.get(msg.sessionId);
      if (s) for (const h of [...(s.handlers.get(msg.method) ?? [])]) h(msg.params);
      return;
    }
    if (msg.method === 'Target.detachedFromTarget' && !closingOurselves) {
      const s = sessions.get(msg.params?.sessionId);
      if (s) fireClose(s, 'target closed');
    }
    if (msg.method === 'Target.targetDestroyed') {
      for (const s of sessions.values()) if (s.targetId === msg.params?.targetId) fireClose(s, 'target closed');
    }
    for (const h of [...(browserHandlers.get(msg.method) ?? [])]) h(msg.params);
  });
  ws.on('close', () => {
    disconnected = 'browser disconnected';
    for (const p of pending.values()) p.reject(new Error(disconnected));
    pending.clear();
    for (const s of sessions.values()) fireClose(s, 'browser disconnected');
  });

  const browser: BrowserCdp = { send: (m, p) => raw(m, p), on: (e, h) => addHandler(browserHandlers, e, h) };

  /** Attaches a flat session to a target over this connection. */
  const attach = async (targetId: string): Promise<{ client: CdpClient; sessionId: string }> => {
    const { sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const s: Session = { id: sessionId, targetId, handlers: new Map(), closeHandlers: new Set(), closedReason: null };
    sessions.set(sessionId, s);
    const client: CdpClient = {
      send: <T>(method: string, params?: object) => raw<T>(method, params, sessionId),
      on: (event, h) => addHandler(s.handlers, event, h),
      onClose(h) {
        if (s.closedReason !== null) {
          h(s.closedReason);
          return () => {};
        }
        s.closeHandlers.add(h);
        return () => void s.closeHandlers.delete(h);
      },
    };
    return { client, sessionId };
  };

  let main: { client: CdpClient; sessionId: string };
  let targetId: string;
  try {
    if (opts.createUrl !== undefined) {
      // Some browsers (e.g. Obscura) scope tabs to the connection that created them, so create here.
      ({ targetId } = await browser.send<{ targetId: string }>('Target.createTarget', { url: opts.createUrl }));
    } else {
      const { targetInfos } = await browser.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
      targetId = pickTarget(targetInfos, opts.targetId).targetId;
    }
    await browser.send('Target.setDiscoverTargets', { discover: true });
    main = await attach(targetId);
  } catch (e) {
    ws.close();
    throw e;
  }

  const popups: PopupSource = {
    onPopup(cb) {
      return browser.on('Target.targetCreated', (e: { targetInfo: TargetInfo }) => {
        if (e.targetInfo.type !== 'page' || e.targetInfo.openerId !== targetId) return;
        attach(e.targetInfo.targetId).then(({ client }) => cb(client), () => {});
      });
    },
  };

  return {
    ...main.client,
    targetId,
    browser,
    popups,
    async close() {
      closingOurselves = true;
      if (disconnected === null && sessions.get(main.sessionId)?.closedReason === null) {
        await browser.send('Target.detachFromTarget', { sessionId: main.sessionId }).catch(() => {});
      }
      if (ws.readyState === WebSocket.OPEN) {
        const closed = new Promise((r) => ws.once('close', r));
        ws.close();
        await closed;
      }
    },
  };
}
