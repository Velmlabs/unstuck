/** Minimal CDP client the engine needs. Implemented by the stdio tunnel (engine) and by in-process hosts. */
export interface CdpClient {
  send<T = unknown>(method: string, params?: object): Promise<T>;
  /** Subscribe to a CDP event; returns an unsubscribe function. */
  on(event: string, handler: (params: any) => void): () => void;
  /** Fires once when the page/session is gone. Returns an unsubscribe function. */
  onClose(handler: (reason: string) => void): () => void;
}
