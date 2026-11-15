// A Puppeteer-shaped page over one raw CDP WebSocket, standing in for @cloudflare/puppeteer (which `wrangler dev` can't reach offline).
// Only what sdk-ts/src/attach.ts and in-process.ts use: createCDPSession(), on/off('close'|'popup'), url(), isClosed().

type Handler = (params: any) => void;
type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

interface Browser {
  send(method: string, params?: object, sessionId?: string): Promise<any>;
  listen(h: (m: Message) => void): () => void;
}

/** Opens Chromium's browser socket from workerd: an outbound WebSocket is a fetch with `Upgrade: websocket`. */
async function connectBrowser(browserWsUrl: string): Promise<Browser> {
  const resp = await fetch(browserWsUrl.replace(/^ws/, 'http'), { headers: { Upgrade: 'websocket' } });
  const ws = (resp as unknown as { webSocket: WebSocket | null }).webSocket;
  if (!ws) throw new Error(`CDP upgrade failed: ${resp.status}`);
  (ws as unknown as { accept(): void }).accept();
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(m: Message) => void>();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)) as Message;
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error.message));
      else p?.resolve(m.result);
      return;
    }
    for (const l of [...listeners]) l(m);
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.reject(new Error('CDP socket closed'));
    pending.clear();
    for (const l of [...listeners]) l({ method: 'Target.targetDestroyed', params: { targetId: '*' } });
  });
  await new Promise<void>((resolve, reject) => {
    pending.set(0, { resolve: () => resolve(), reject });
    ws.send(JSON.stringify({ id: 0, method: 'Target.setDiscoverTargets', params: { discover: true } }));
  });
  return {
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    listen(h) {
      listeners.add(h);
      return () => void listeners.delete(h);
    },
  };
}

function pageFor(browser: Browser, targetId: string, initialUrl: string) {
  let url = initialUrl;
  let closed = false;
  const handlers = new Map<string, Set<Handler>>();
  const emit = (event: string, arg?: unknown) => {
    for (const h of [...(handlers.get(event) ?? [])]) h(arg);
  };
  browser.listen((m) => {
    if (m.sessionId) return;
    const info = m.params?.targetInfo;
    if (m.method === 'Target.targetInfoChanged' && info?.targetId === targetId) url = info.url;
    else if (m.method === 'Target.targetCreated' && info?.type === 'page' && info.openerId === targetId) emit('popup', pageFor(browser, info.targetId, info.url));
    else if (m.method === 'Target.targetDestroyed' && !closed && (m.params.targetId === targetId || m.params.targetId === '*')) {
      closed = true;
      emit('close');
    }
  });
  return {
    url: () => url,
    isClosed: () => closed,
    on(event: string, h: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(h);
    },
    off(event: string, h: Handler) {
      handlers.get(event)?.delete(h);
    },
    async createCDPSession() {
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      const subs = new Map<string, Set<Handler>>();
      const stop = browser.listen((m) => {
        if (m.sessionId === sessionId && m.method) for (const h of [...(subs.get(m.method) ?? [])]) h(m.params);
      });
      return {
        send: (method: string, params?: object) => browser.send(method, params, sessionId),
        on(event: string, h: Handler) {
          if (!subs.has(event)) subs.set(event, new Set());
          subs.get(event)!.add(h);
        },
        async detach() {
          stop();
          await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        },
      };
    },
  };
}

/** A Puppeteer-shaped page for the target `targetId` of the Chromium whose browser socket is `browserWsUrl`. */
export async function createCdpPage(browserWsUrl: string, targetId: string) {
  const browser = await connectBrowser(browserWsUrl);
  const { targetInfo } = await browser.send('Target.getTargetInfo', { targetId });
  return pageFor(browser, targetId, targetInfo.url);
}
