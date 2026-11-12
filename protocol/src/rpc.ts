import type { RpcError, RpcNotification, RpcRequest, RpcResponse } from './rpc-types';

export class RpcCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RpcCallError';
  }
}

export interface RpcPeer {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  handle(method: string, fn: (params: unknown) => unknown): void;
  onNotification(method: string, fn: (params: unknown) => void): void;
  receive(line: string): void;
  close(reason: string): void;
}

/** Bidirectional JSON-lines RPC. Transport-agnostic: caller supplies `write` and feeds `receive`. */
export function createRpcPeer(write: (line: string) => void): RpcPeer {
  let nextId = 1;
  let closedReason: string | null = null;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const handlers = new Map<string, (params: unknown) => unknown>();
  const listeners = new Map<string, Array<(params: unknown) => void>>();

  const send = (msg: RpcRequest | RpcResponse | RpcNotification) => write(JSON.stringify(msg));

  async function onRequest(msg: RpcRequest): Promise<void> {
    const fn = handlers.get(msg.method);
    if (!fn) {
      send({ id: msg.id, error: { code: 'unknown_method', message: `unknown method ${msg.method}` } });
      return;
    }
    try {
      send({ id: msg.id, result: (await fn(msg.params)) ?? null });
    } catch (e) {
      const err = e as Partial<RpcError> & { message?: string };
      send({ id: msg.id, error: { code: typeof err.code === 'string' ? err.code : 'handler_error', message: String(err.message ?? e) } });
    }
  }

  return {
    request<T>(method: string, params?: unknown): Promise<T> {
      if (closedReason !== null) return Promise.reject(new RpcCallError('closed', closedReason));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        send({ id, method, params });
      });
    },
    notify(method, params) {
      send({ method, params });
    },
    handle(method, fn) {
      handlers.set(method, fn);
    },
    onNotification(method, fn) {
      listeners.set(method, [...(listeners.get(method) ?? []), fn]);
    },
    receive(line) {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as Partial<RpcRequest & RpcResponse>;
      if (typeof m.id === 'number' && typeof m.method === 'string') {
        void onRequest(m as RpcRequest);
      } else if (typeof m.id === 'number') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.error) p.reject(new RpcCallError(m.error.code, m.error.message));
        else p.resolve(m.result);
      } else if (typeof m.method === 'string') {
        for (const fn of listeners.get(m.method) ?? []) fn(m.params);
      }
    },
    close(reason) {
      closedReason = reason;
      for (const p of pending.values()) p.reject(new RpcCallError('closed', reason));
      pending.clear();
    },
  };
}
