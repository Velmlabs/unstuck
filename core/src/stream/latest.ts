export interface FrameSink {
  send(b: Uint8Array): void;
  readonly bufferedAmount: number;
}

/**
 * Newest-frame-only sender: never queues more than one pending frame per viewer.
 * Slow viewers skip frames instead of building a backlog.
 */
export function createLatestSender(conn: FrameSink, opts: { highWaterMark?: number } = {}) {
  const mark = opts.highWaterMark ?? 512 * 1024;
  let pending: Uint8Array | null = null;
  return {
    push(frame: Uint8Array): void {
      if (conn.bufferedAmount < mark) {
        pending = null;
        conn.send(frame);
      } else {
        pending = frame;
      }
    },
    drain(): void {
      if (pending && conn.bufferedAmount < mark) {
        const f = pending;
        pending = null;
        conn.send(f);
      }
    },
  };
}
