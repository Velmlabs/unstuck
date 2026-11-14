import { Methods, type CdpClosedParams, type CdpEventParams, type RpcPeer } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '@velmlabs/unstuck-core';

/** A CdpClient whose commands and events travel over the SDK's own CDP session (stdio RPC). */
export function createTunneledCdp(peer: RpcPeer, pageId: string): CdpClient {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const subscribed = new Set<string>();
  const closeHandlers = new Set<(reason: string) => void>();
  let closedReason: string | null = null;

  peer.onNotification(Methods.cdpEvent, (raw) => {
    const e = raw as CdpEventParams;
    if (e.pageId !== pageId) return;
    for (const h of [...(handlers.get(e.method) ?? [])]) h(e.params);
  });
  peer.onNotification(Methods.cdpClosed, (raw) => {
    const e = raw as CdpClosedParams;
    if (e.pageId !== pageId || closedReason !== null) return;
    closedReason = e.reason;
    for (const h of [...closeHandlers]) h(e.reason);
  });

  return {
    send<T>(method: string, params?: object): Promise<T> {
      return peer.request<T>(Methods.cdpSend, { pageId, method, params });
    },
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      if (!subscribed.has(event)) {
        subscribed.add(event);
        peer.request(Methods.cdpSubscribe, { pageId, events: [event] }).catch(() => {});
      }
      return () => void set.delete(handler);
    },
    onClose(handler) {
      if (closedReason !== null) {
        handler(closedReason);
        return () => {};
      }
      closeHandlers.add(handler);
      return () => void closeHandlers.delete(handler);
    },
  };
}
