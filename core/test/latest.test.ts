import { describe, it, expect } from 'vitest';
import { decodeFrame, encodeFrame } from '@velmlabs/unstuck-protocol';
import { createLatestSender, CREDIT_ACK_TIMEOUT_MS, CREDIT_MAX_IN_FLIGHT } from '../src/stream/latest';

function conn(buffered = 0) {
  const sent: Uint8Array[] = [];
  return { sent, bufferedAmount: buffered, send: (b: Uint8Array) => void sent.push(b) };
}
const f = (n: number) => new Uint8Array([n]);

describe('createLatestSender', () => {
  it('sends every frame while the socket is not backed up', () => {
    const c = conn();
    const s = createLatestSender(c);
    s.push(f(1));
    s.push(f(2));
    s.push(f(3));
    expect(c.sent).toEqual([f(1), f(2), f(3)]);
  });

  it('keeps only the newest frame while backed up and sends it on drain', () => {
    const c = conn(600 * 1024);
    const s = createLatestSender(c);
    s.push(f(1));
    s.push(f(2));
    s.push(f(3));
    expect(c.sent).toEqual([]);
    s.drain();
    expect(c.sent).toEqual([]);
    c.bufferedAmount = 0;
    s.drain();
    expect(c.sent).toEqual([f(3)]);
    s.drain();
    expect(c.sent).toEqual([f(3)]);
  });

  it('uses the default high-water mark of 512 KiB', () => {
    const c = conn(512 * 1024 - 1);
    createLatestSender(c).push(f(1));
    expect(c.sent).toHaveLength(1);
    const d = conn(512 * 1024);
    createLatestSender(d).push(f(1));
    expect(d.sent).toHaveLength(0);
  });

  it('honours a custom high-water mark', () => {
    const c = conn(10);
    createLatestSender(c, { highWaterMark: 5 }).push(f(1));
    expect(c.sent).toHaveLength(0);
  });

  it('a new push after a pending frame sends the newer one once there is room', () => {
    const c = conn(600 * 1024);
    const s = createLatestSender(c);
    s.push(f(1));
    c.bufferedAmount = 0;
    s.push(f(2));
    expect(c.sent).toEqual([f(2)]);
    s.drain();
    expect(c.sent).toEqual([f(2)]);
  });
});

describe('createLatestSender with frame credit', () => {
  /** Encoded type-1 frames, told apart by their single JPEG byte. */
  const jf = (n: number) => encodeFrame({ width: 10, height: 20, jpeg: new Uint8Array([n]) });
  const sentFrames = (c: { sent: Uint8Array[] }) => c.sent.map((b) => decodeFrame(b)!).map((d) => ({ n: d.jpeg[0], seq: d.seq }));
  function credited(buffered = 0) {
    const c = conn(buffered);
    let t = 1_000;
    const s = createLatestSender(c, { now: () => t });
    s.enableCredit();
    return { c, s, advance: (ms: number) => void (t += ms) };
  }

  it('allows two unacknowledged frames', () => {
    expect(CREDIT_MAX_IN_FLIGHT).toBe(2);
    expect(CREDIT_ACK_TIMEOUT_MS).toBe(1_000);
  });

  it('numbers frames from 1 as type-2 frames and holds the third until an ack', () => {
    const { c, s } = credited();
    s.push(jf(1));
    s.push(jf(2));
    s.push(jf(3));
    expect(sentFrames(c)).toEqual([
      { n: 1, seq: 1 },
      { n: 2, seq: 2 },
    ]);
    s.drain();
    expect(c.sent).toHaveLength(2);
    s.ack(1);
    expect(sentFrames(c).at(-1)).toEqual({ n: 3, seq: 3 });
  });

  it('a newer frame replaces the one waiting for credit; the ack releases the newest', () => {
    const { c, s } = credited();
    for (const n of [1, 2, 3, 4, 5]) s.push(jf(n));
    s.ack(2);
    expect(sentFrames(c)).toEqual([
      { n: 1, seq: 1 },
      { n: 2, seq: 2 },
      { n: 5, seq: 3 },
    ]);
    // Nothing pending any more: further acks send nothing.
    s.ack(3);
    expect(c.sent).toHaveLength(3);
    s.push(jf(6));
    expect(sentFrames(c).at(-1)).toEqual({ n: 6, seq: 4 });
  });

  it('an ack is cumulative: it covers every earlier frame (dropped or skipped by the viewer)', () => {
    const { c, s } = credited();
    s.push(jf(1));
    s.push(jf(2));
    s.ack(2);
    s.push(jf(3));
    s.push(jf(4));
    s.push(jf(5));
    expect(sentFrames(c).map((f) => f.seq)).toEqual([1, 2, 3, 4]);
  });

  it('stale, duplicate and not-yet-sent acks are ignored and never add credit', () => {
    const { c, s } = credited();
    s.push(jf(1));
    s.push(jf(2));
    s.ack(1);
    s.push(jf(3)); // seq 3: in flight now 2 and 3
    s.push(jf(4)); // waits
    s.ack(1); // duplicate
    s.ack(1);
    s.ack(0);
    s.ack(-5);
    s.ack(99); // never sent: can't be acknowledged
    s.ack(2.5);
    s.ack(Number.NaN);
    expect(c.sent).toHaveLength(3);
    s.ack(2);
    expect(sentFrames(c).at(-1)).toEqual({ n: 4, seq: 4 });
  });

  it('grants one frame when no ack arrives for a second while credit is exhausted, and again a second later', () => {
    const { c, s, advance } = credited();
    s.push(jf(1));
    s.push(jf(2));
    s.push(jf(3));
    advance(999);
    s.drain();
    expect(c.sent).toHaveLength(2);
    advance(1);
    s.drain();
    expect(sentFrames(c).at(-1)).toEqual({ n: 3, seq: 3 });
    s.push(jf(4));
    s.drain();
    expect(c.sent).toHaveLength(3);
    advance(1_000);
    s.drain();
    expect(sentFrames(c).at(-1)).toEqual({ n: 4, seq: 4 });
    // Late acks for those frames still count, and only once.
    s.push(jf(5));
    s.ack(4);
    expect(sentFrames(c).at(-1)).toEqual({ n: 5, seq: 5 });
  });

  it('the ack timeout counts from the send that used the last credit, not from an old quiet period', () => {
    const { c, s, advance } = credited();
    s.push(jf(1));
    s.ack(1);
    advance(10_000); // a static page: no frames for a while
    s.push(jf(2));
    s.push(jf(3));
    s.push(jf(4)); // credit exhausted just now: waits
    expect(c.sent).toHaveLength(3);
    advance(500);
    s.drain();
    expect(c.sent).toHaveLength(3);
  });

  it('still respects the socket buffer: credit alone does not send into a backed-up socket', () => {
    const { c, s } = credited(600 * 1024);
    s.push(jf(1));
    expect(c.sent).toHaveLength(0);
    c.bufferedAmount = 0;
    s.drain();
    expect(sentFrames(c)).toEqual([{ n: 1, seq: 1 }]);
  });

  it('clear() drops the pending frame but keeps numbering and credit (a popup switch on the same viewer)', () => {
    const { c, s } = credited();
    s.push(jf(1));
    s.push(jf(2));
    s.push(jf(3));
    s.clear();
    s.ack(2);
    expect(c.sent).toHaveLength(2);
    s.push(jf(4));
    expect(sentFrames(c).at(-1)).toEqual({ n: 4, seq: 3 });
  });

  it('without negotiation nothing changes: type-1 frames, no credit limit, acks ignored', () => {
    const c = conn();
    const s = createLatestSender(c);
    const frames = [1, 2, 3, 4, 5].map(jf);
    for (const fr of frames) s.push(fr);
    s.ack(1);
    s.drain();
    expect(c.sent).toEqual(frames);
  });

  it('frames sent before the viewer opted in are not counted against its credit', () => {
    const c = conn();
    const s = createLatestSender(c, { now: () => 0 });
    s.push(jf(1));
    s.push(jf(2));
    s.enableCredit();
    s.enableCredit(); // idempotent
    s.push(jf(3));
    s.push(jf(4));
    s.push(jf(5));
    expect(c.sent.slice(0, 2)).toEqual([jf(1), jf(2)]);
    expect(sentFrames(c).slice(2)).toEqual([
      { n: 3, seq: 1 },
      { n: 4, seq: 2 },
    ]);
  });

  it('uses Date.now by default for the ack timeout', () => {
    const real = Date.now;
    let t = 5_000;
    Date.now = () => t;
    try {
      const c = conn();
      const s = createLatestSender(c);
      s.enableCredit();
      s.push(jf(1));
      s.push(jf(2));
      s.push(jf(3));
      t += CREDIT_ACK_TIMEOUT_MS;
      s.drain();
      expect(c.sent).toHaveLength(3);
    } finally {
      Date.now = real;
    }
  });
});

