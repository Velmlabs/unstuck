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
  /** Makes /s/<id> reachable until `expiresAt`; the session appends `#t=<token>&k=<key>` to baseUrl. */
  publish(sessionId: string, opts: { expiresAt: number }): Promise<{ baseUrl: string }>;
  /** Optional: reports when the path to humans goes down or comes back (a relay connection). */
  onStatus?(sessionId: string, h: (s: 'up' | 'down') => void): void;
  onConnection(sessionId: string, h: (conn: ViewerConnection) => void): void;
  unpublish(sessionId: string): Promise<void>;
  close(): Promise<void>;
}
