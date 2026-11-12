import type { CdpClient } from '../cdp';

/** In-memory CdpClient for tests: records calls, lets tests emit events and close the page. */
export class FakeCdp implements CdpClient {
  readonly calls: { method: string; params?: object }[] = [];
  private readonly handlers = new Map<string, Set<(p: any) => void>>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  private readonly responders = new Map<string, (params?: object) => unknown>();
  closed: string | null = null;

  respond(method: string, fn: (params?: object) => unknown): void {
    this.responders.set(method, fn);
  }

  async send<T = unknown>(method: string, params?: object): Promise<T> {
    this.calls.push({ method, params });
    if (this.closed !== null) throw new Error(`page closed: ${this.closed}`);
    const fn = this.responders.get(method);
    return (fn ? await fn(params) : {}) as T;
  }

  on(event: string, handler: (params: any) => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  emit(event: string, params: unknown): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) h(params);
  }

  close(reason: string): void {
    this.closed = reason;
    for (const h of [...this.closeHandlers]) h(reason);
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
