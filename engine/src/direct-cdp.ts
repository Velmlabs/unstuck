import { WebSocket } from 'ws';
import type { CdpClient } from '@unstuck/core';

/** Browser-level CDP access (no session), e.g. for Target.* discovery. */
export interface BrowserCdp {
  send<T = unknown>(method: string, params?: object): Promise<T>;
  on(event: string, handler: (params: any) => void): () => void;
}

export interface DirectCdp extends CdpClient {
  targetId: string;
  browser: BrowserCdp;
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

/** Connects straight to a browser's DevTools endpoint and attaches to one page target. */
export async function connectCdp(url: string, opts: { targetId?: string; fetchImpl?: typeof fetch } = {}): Promise<DirectCdp> {
  const ws = new WebSocket(await resolveWsUrl(normalizeCdpUrl(url), opts.fetchImpl ?? fetch), { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(new Error(`could not reach the browser at ${url}: ${e.message}`)));
  });

  let nextId = 1;
  let disconnected: string | null = null;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const browserHandlers = new Map<string, Set<(p: any) => void>>();
  const pageHandlers = new Map<string, Set<(p: any) => void>>();
  const closeHandlers = new Set<(reason: string) => void>();
  let sessionId: string | undefined;
  let targetId = '';
  let closedReason: string | null = null;
  let closingOurselves = false;

  const fireClose = (reason: string) => {
    if (closedReason !== null) return;
    closedReason = reason;
    for (const h of [...closeHandlers]) h(reason);
  };

  const raw = <T>(method: string, params: object | undefined, sid?: string): Promise<T> => {
    if (disconnected !== null) return Promise.reject(new Error(disconnected));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params ?? {}, ...(sid ? { sessionId: sid } : {}) }));
    });
  };

  const add = (map: Map<string, Set<(p: any) => void>>, event: string, h: (p: any) => void) => {
    const set = map.get(event) ?? new Set();
    set.add(h);
    map.set(event, set);
    return () => void set.delete(h);
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
      if (msg.sessionId === sessionId) for (const h of [...(pageHandlers.get(msg.method) ?? [])]) h(msg.params);
      return;
    }
    if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId === sessionId && !closingOurselves) fireClose('target closed');
    if (msg.method === 'Target.targetDestroyed' && msg.params?.targetId === targetId) fireClose('target closed');
    for (const h of [...(browserHandlers.get(msg.method) ?? [])]) h(msg.params);
  });
  ws.on('close', () => {
    disconnected = 'browser disconnected';
    for (const p of pending.values()) p.reject(new Error(disconnected));
    pending.clear();
    fireClose('browser disconnected');
  });

  const browser: BrowserCdp = { send: (m, p) => raw(m, p), on: (e, h) => add(browserHandlers, e, h) };
  try {
    const { targetInfos } = await browser.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    targetId = pickTarget(targetInfos, opts.targetId).targetId;
    await browser.send('Target.setDiscoverTargets', { discover: true });
    ({ sessionId } = await browser.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true }));
  } catch (e) {
    ws.close();
    throw e;
  }

  return {
    targetId,
    browser,
    send: <T>(method: string, params?: object) => raw<T>(method, params, sessionId),
    on: (event, h) => add(pageHandlers, event, h),
    onClose(h) {
      if (closedReason !== null) {
        h(closedReason);
        return () => {};
      }
      closeHandlers.add(h);
      return () => void closeHandlers.delete(h);
    },
    async close() {
      closingOurselves = true;
      if (disconnected === null && closedReason === null) await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      if (ws.readyState === WebSocket.OPEN) {
        const closed = new Promise((r) => ws.once('close', r));
        ws.close();
        await closed;
      }
    },
  };
}
