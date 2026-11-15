import type { CdpClient } from '@velmlabs/unstuck-core';
import type { AttachedPage } from './attach';

/** Core's CdpClient straight on the page's CDP session (in-process mode: no RPC tunnel). */
export function toCdpClient(page: AttachedPage): CdpClient {
  // One page subscription per event; handlers come and go in its set (the session can't unsubscribe).
  const handlers = new Map<string, Set<(params: any) => void>>();
  const closeHandlers = new Set<(reason: string) => void>();
  let closedReason: string | null = null;
  page.onClose((reason) => {
    closedReason = reason;
    for (const h of [...closeHandlers]) h(reason);
    closeHandlers.clear();
  });
  return {
    send: <T>(method: string, params?: object) => page.send(method, params) as Promise<T>,
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        const fresh = new Set<(params: any) => void>();
        handlers.set(event, fresh);
        page.subscribe(event, (params) => {
          for (const h of [...fresh]) h(params);
        });
        set = fresh;
      }
      set.add(handler);
      return () => void set.delete(handler);
    },
    onClose(handler) {
      if (closedReason !== null) {
        // Already gone: still asynchronous, like a close that happens later, and cancellable until then.
        const reason = closedReason;
        let active = true;
        queueMicrotask(() => active && handler(reason));
        return () => void (active = false);
      }
      closeHandlers.add(handler);
      return () => void closeHandlers.delete(handler);
    },
  };
}

/**
 * Pings the page (`Runtime.evaluate` of a constant) every interval, so a remote browser that closes idle sessions
 * (Browser Rendering's keep_alive) stays up while nobody has opened the link yet. Returns stop.
 */
export function startKeepAlive(cdp: CdpClient, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    cdp.send('Runtime.evaluate', { expression: '0' }).catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}
