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

export class FakeTransport implements Transport {
  readonly published = new Set<string>();
  readonly unpublished: string[] = [];
  closed = false;
  private readonly handlers = new Map<string, (c: ViewerConnection) => void>();

  async publish(sessionId: string): Promise<{ baseUrl: string }> {
    this.published.add(sessionId);
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
  /** Open a new viewer connection to a published session. */
  connect(sessionId: string): FakeViewer {
    const h = this.handlers.get(sessionId);
    if (!h) throw new Error(`session ${sessionId} not published`);
    const v = new FakeViewer();
    h(v);
    return v;
  }
}
