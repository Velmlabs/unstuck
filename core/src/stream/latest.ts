import { FRAME_SEQ_MAX, withFrameSeq } from '@velmlabs/unstuck-protocol';

export interface FrameSink {
  send(b: Uint8Array): void;
  readonly bufferedAmount: number;
}

/** Frames a credit-mode viewer may have unacknowledged (sent, not yet drawn). */
export const CREDIT_MAX_IN_FLIGHT = 2;
/** With credit exhausted and no ack for this long, one more frame goes out: a lost ack must never freeze the stream. */
export const CREDIT_ACK_TIMEOUT_MS = 1_000;

export interface LatestSenderOptions {
  highWaterMark?: number;
  /** Clock for the ack timeout (default Date.now). */
  now?: () => number;
}

export interface LatestSender {
  /** Sends `frame` (an encoded type-1 frame) now if there is room, else keeps it as the one pending frame. */
  push(frame: Uint8Array): void;
  /** Sends the pending frame if there is room now (called on a timer and after each ack). */
  drain(): void;
  /** Drops the pending frame (the stream moved to another page); numbering and credit carry on. */
  clear(): void;
  /**
   * The viewer opted in to frame credit: from now on frames go out as type 2 with a sequence number, and at most
   * CREDIT_MAX_IN_FLIGHT of them may be unacknowledged. Without this call the sender behaves exactly as before.
   */
  enableCredit(): void;
  /** The viewer has drawn frame `seq` (and so is done with every earlier one). Stale, duplicate and unknown acks are ignored. */
  ack(seq: number): void;
}

/**
 * Newest-frame-only sender: never queues more than one pending frame per viewer.
 * Slow viewers skip frames instead of building a backlog. Two signals hold frames back: the socket's own buffer
 * (bufferedAmount, where the runtime reports it) and, once negotiated, end-to-end frame credit from the viewer's acks
 * (which also works where bufferedAmount is always 0: Workers' client sockets, a Durable Object relay).
 */
export function createLatestSender(conn: FrameSink, opts: LatestSenderOptions = {}): LatestSender {
  const mark = opts.highWaterMark ?? 512 * 1024;
  const now = opts.now ?? Date.now;
  let pending: Uint8Array | null = null;
  let credit = false;
  /** Sequence number of the last frame sent in credit mode (0: none yet). */
  let sentSeq = 0;
  /** Highest sequence number acknowledged (or granted by the timeout). */
  let ackedSeq = 0;
  /** Last send or accepted ack: the ack timeout counts from here. */
  let since = 0;

  const room = (): boolean => {
    if (!(conn.bufferedAmount < mark)) return false;
    if (!credit || sentSeq - ackedSeq < CREDIT_MAX_IN_FLIGHT) return true;
    if (now() - since < CREDIT_ACK_TIMEOUT_MS) return false;
    ackedSeq = sentSeq - CREDIT_MAX_IN_FLIGHT + 1; // grant one frame
    return true;
  };
  const send = (frame: Uint8Array): void => {
    if (!credit) return conn.send(frame);
    // Wrapping takes years at 60 fps; start over rather than send a number the viewer can't ack.
    if (sentSeq === FRAME_SEQ_MAX) sentSeq = ackedSeq = 0;
    conn.send(withFrameSeq(frame, ++sentSeq));
    since = now();
  };
  const drain = (): void => {
    if (pending && room()) {
      const f = pending;
      pending = null;
      send(f);
    }
  };

  return {
    push(frame) {
      if (room()) {
        pending = null;
        send(frame);
      } else {
        pending = frame;
      }
    },
    drain,
    clear() {
      pending = null;
    },
    enableCredit() {
      if (credit) return;
      credit = true;
      since = now();
    },
    ack(seq) {
      if (!credit || !Number.isInteger(seq) || seq <= ackedSeq || seq > sentSeq) return;
      ackedSeq = seq;
      since = now();
      drain();
    },
  };
}
