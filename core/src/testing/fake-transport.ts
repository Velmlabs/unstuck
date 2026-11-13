import { b64urlDecode, importE2eKey, isJsonPlaintext, open, seal } from '@unstuck/protocol';
import type { Transport, ViewerConnection } from '../transport';

/** A fake human's browser tab connected to the session. */
export class FakeViewer implements ViewerConnection {
  readonly sent: (string | Uint8Array)[] = [];
  bufferedAmount = 0;
  closed: { code?: number; reason?: string } | null = null;
  private messageHandlers: ((d: string | Uint8Array) => void)[] = [];
  private closeHandlers: (() => void)[] = [];

  send(data: string | Uint8Array): void {
    if (!this.closed) this.sent.push(data);
  }
  onMessage(h: (d: string | Uint8Array) => void): void {
    this.messageHandlers.push(h);
  }
  onClose(h: () => void): void {
    this.closeHandlers.push(h);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    for (const h of this.closeHandlers) h();
  }
  /** Simulate the human's browser sending a JSON message (or raw text/binary). */
  push(msg: object | string | Uint8Array): void {
    const data = typeof msg === 'string' || msg instanceof Uint8Array ? msg : JSON.stringify(msg);
    for (const h of this.messageHandlers) h(data);
  }
  /** JSON messages received from the engine. */
  json(): any[] {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d));
  }
  binary(): Uint8Array[] {
    return this.sent.filter((d): d is Uint8Array => d instanceof Uint8Array);
  }
}

/**
 * A human's tab that speaks plaintext to the test but end-to-end ciphertext on the wire, like the real viewer.
 * `raw` is the connection the engine sees; `sent`/`json()`/`binary()` are what the human decrypted.
 */
export class SealedFakeViewer extends FakeViewer {
  readonly raw = new FakeViewer();
  private key: Promise<CryptoKey | null>;
  private inChain: Promise<void> = Promise.resolve();
  private outChain: Promise<void> = Promise.resolve();

  constructor(private readonly sessionId: string, rawKey: Uint8Array | null) {
    super();
    this.key = rawKey && rawKey.length === 32 ? importE2eKey(rawKey) : Promise.resolve(null);
    const rawSend = this.raw.send.bind(this.raw);
    this.raw.send = (data) => {
      rawSend(data);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      this.inChain = this.inChain.then(async () => {
        const k = await this.key;
        const p = k ? await open(k, this.sessionId, 'e2v', bytes) : null;
        if (p) this.sent.push(isJsonPlaintext(p) ? new TextDecoder().decode(p) : p);
      });
    };
    this.raw.onClose(() => {
      if (!this.closed) this.closed = this.raw.closed;
    });
  }
  /** The human sends a message: sealed with the link's key (plaintext if the link had none). */
  override push(msg: object | string | Uint8Array): void {
    const data = typeof msg === 'string' || msg instanceof Uint8Array ? msg : JSON.stringify(msg);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.outChain = this.outChain.then(async () => {
      const k = await this.key;
      this.raw.push(k ? await seal(k, this.sessionId, 'v2e', bytes) : bytes);
    });
  }
  override close(code?: number, reason?: string): void {
    super.close(code, reason);
    this.raw.close(code, reason);
  }
}

export class FakeTransport implements Transport {
  readonly published = new Set<string>();
  readonly expiries = new Map<string, number>();
  private readonly statusHandlers = new Map<string, (s: 'up' | 'down') => void>();
  readonly unpublished: string[] = [];
  closed = false;
  private readonly handlers = new Map<string, (c: ViewerConnection) => void>();

  async publish(sessionId: string, opts: { expiresAt: number }): Promise<{ baseUrl: string }> {
    this.published.add(sessionId);
    this.expiries.set(sessionId, opts.expiresAt);
    return { baseUrl: `http://fake.test/s/${sessionId}` };
  }
  onConnection(sessionId: string, h: (c: ViewerConnection) => void): void {
    this.handlers.set(sessionId, h);
  }
  async unpublish(sessionId: string): Promise<void> {
    this.published.delete(sessionId);
    this.handlers.delete(sessionId);
    this.unpublished.push(sessionId);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  onStatus(sessionId: string, h: (s: 'up' | 'down') => void): void {
    this.statusHandlers.set(sessionId, h);
  }
  /** Simulate the relay connection going down or coming back. */
  setStatus(sessionId: string, s: 'up' | 'down'): void {
    this.statusHandlers.get(sessionId)?.(s);
  }
  /** Open a human's tab from a takeover link (`…/s/<id>#t=…&k=…`); the key in the link seals everything. */
  connect(link: string): SealedFakeViewer {
    const u = new URL(link);
    const sessionId = u.pathname.split('/').pop()!;
    const h = this.handlers.get(sessionId);
    if (!h) throw new Error(`session ${sessionId} not published`);
    const k = new URLSearchParams(u.hash.slice(1)).get('k');
    const v = new SealedFakeViewer(sessionId, k ? b64urlDecode(k) : null);
    h(v.raw);
    return v;
  }
}
