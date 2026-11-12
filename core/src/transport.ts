/** One connected human viewer (a WebSocket on Node, a Durable Object socket on Workers, ...). */
export interface ViewerConnection {
  send(data: string | Uint8Array): void;
  readonly bufferedAmount: number;
  onMessage(h: (data: string | Uint8Array) => void): void;
  onClose(h: () => void): void;
  close(code?: number, reason?: string): void;
}

/** How takeover links reach humans: embedded local server, relay, or Cloud. */
export interface Transport {
  /** Makes /s/<id> reachable; the session appends `#t=<token>` to baseUrl. */
  publish(sessionId: string): Promise<{ baseUrl: string }>;
  onConnection(sessionId: string, h: (conn: ViewerConnection) => void): void;
  unpublish(sessionId: string): Promise<void>;
  close(): Promise<void>;
}
