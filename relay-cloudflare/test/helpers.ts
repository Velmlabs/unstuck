import { exports } from 'cloudflare:workers';
import { b64urlDecode, importE2eKey, isJsonPlaintext, openMsg, sealMsg } from '@velmlabs/unstuck-protocol';

/** A WebSocket-shaped client over the Worker's fetch (no real network inside workerd tests). */
export class FetchWs {
  static all: FetchWs[] = [];
  readyState = 0;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  protocol = '';
  status = 0;
  private ws: WebSocket | null = null;
  constructor(url: string, protocols: string[] = []) {
    FetchWs.all.push(this);
    void this.start(url, protocols);
  }
  private async start(url: string, protocols: string[]) {
    const res = await exports.default.fetch(
      new Request(url.replace(/^ws/, 'http'), {
        // Each socket from its own address, like separate clients (per-IP limits are tested explicitly).
        headers: { Upgrade: 'websocket', 'cf-connecting-ip': `10.${FetchWs.all.length >> 8 & 255}.${FetchWs.all.length & 255}.${Math.floor(Math.random() * 256)}`, ...(protocols.length ? { 'Sec-WebSocket-Protocol': protocols.join(', ') } : {}) },
      }),
    );
    this.status = res.status;
    this.protocol = res.headers.get('sec-websocket-protocol') ?? '';
    const ws = res.webSocket;
    if (!ws) {
      this.readyState = 3;
      return this.onclose?.({ code: 1006, reason: String(res.status) });
    }
    this.ws = ws;
    ws.accept();
    this.readyState = 1;
    ws.addEventListener('message', (e) => this.onmessage?.({ data: e.data }));
    ws.addEventListener('close', (e) => {
      this.readyState = 3;
      this.onclose?.({ code: e.code, reason: e.reason });
    });
    this.onopen?.();
  }
  send(d: string | ArrayBufferLike | Uint8Array) {
    this.ws?.send(d as never);
  }
  close(code = 1000, reason?: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.ws?.close(code, reason);
  }
}

export async function viewerFor(link: string) {
  const u = new URL(link);
  const id = u.pathname.split('/').pop()!;
  const frag = new URLSearchParams(u.hash.slice(1));
  const key = await importE2eKey(b64urlDecode(frag.get('k')!)!);
  const sock = new FetchWs(`${u.origin.replace(/^http/, 'ws')}/ws/${id}`);
  const raw: Uint8Array[] = [];
  const json: any[] = [];
  let closeCode: number | null = null;
  // Like the real viewer: the engine's sealed challenge comes first, then sequenced messages bound to its nonce.
  let nonce: string | null = null;
  let seq = 0;
  let chain: Promise<void> = Promise.resolve();
  sock.onmessage = (e) => {
    chain = chain.then(async () => {
      const d = e.data as ArrayBuffer | Blob;
      const b = new Uint8Array(typeof Blob !== 'undefined' && d instanceof Blob ? await d.arrayBuffer() : (d as ArrayBuffer));
      raw.push(b);
      if (nonce === null) {
        const c = await openMsg(key, id, 'e2v', '', b);
        if (c) nonce = JSON.parse(new TextDecoder().decode(c.plain)).n;
        return;
      }
      const m = await openMsg(key, id, 'e2v', nonce, b);
      if (m && isJsonPlaintext(m.plain)) json.push(JSON.parse(new TextDecoder().decode(m.plain)));
    });
  };
  sock.onclose = (e) => (closeCode = e.code);
  await waitFor(() => sock.readyState !== 0);
  const send = async (m: object) => {
    await waitFor(() => nonce !== null);
    sock.send(await sealMsg(key, id, 'v2e', nonce!, ++seq, new TextEncoder().encode(JSON.stringify(m))));
  };
  return { sock, raw, json, send, token: frag.get('t')!, closeCode: () => closeCode };
}

export async function waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}
