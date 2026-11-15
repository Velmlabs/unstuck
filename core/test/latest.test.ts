import { describe, it, expect } from 'vitest';
import { decodeFrame, encodeFrame } from '@velmlabs/unstuck-protocol';
import { createLatestSender, CREDIT_ACK_TIMEOUT_MS, CREDIT_GRANT_MAX_MS, CREDIT_MAX_IN_FLIGHT } from '../src/stream/latest';

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
  const seqs = (c: { sent: Uint8Array[] }) => sentFrames(c).map((f) => f.seq);
  function credited(buffered = 0) {
    const c = conn(buffered);
    let t = 1_000;
    const s = createLatestSender(c, { now: () => t });
    s.enableCredit();
    const push = (...ns: number[]) => ns.forEach((n) => s.push(jf(n)));
    return { c, s, push, advance: (ms: number) => void (t += ms) };
  }

  it('allows three unacknowledged frames; grants start at 1 s and back off to 8 s', () => {
    expect(CREDIT_MAX_IN_FLIGHT).toBe(3);
    expect(CREDIT_ACK_TIMEOUT_MS).toBe(1_000);
    expect(CREDIT_GRANT_MAX_MS).toBe(8_000);
  });

  it('numbers frames from 1 as type-2 frames and holds the fourth until an ack', () => {
    const { c, s, push } = credited();
    push(1, 2, 3, 4);
    expect(sentFrames(c)).toEqual([
      { n: 1, seq: 1 },
      { n: 2, seq: 2 },
      { n: 3, seq: 3 },
    ]);
    s.drain();
    expect(c.sent).toHaveLength(3);
    s.ack(1);
    expect(sentFrames(c).at(-1)).toEqual({ n: 4, seq: 4 });
  });

  it('a newer frame replaces the one waiting for credit; the ack releases the newest', () => {
    const { c, s, push } = credited();
    push(1, 2, 3, 4, 5, 6);
    s.ack(3);
    expect(sentFrames(c)).toEqual([
      { n: 1, seq: 1 },
      { n: 2, seq: 2 },
      { n: 3, seq: 3 },
      { n: 6, seq: 4 },
    ]);
    // Nothing pending any more: further acks send nothing.
    s.ack(4);
    expect(c.sent).toHaveLength(4);
    push(7);
    expect(sentFrames(c).at(-1)).toEqual({ n: 7, seq: 5 });
  });

  it('an ack is cumulative: it covers every earlier frame (dropped or skipped by the viewer)', () => {
    const { c, s, push } = credited();
    push(1, 2, 3);
    s.ack(3);
    push(4, 5, 6, 7);
    expect(seqs(c)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('stale, duplicate and not-yet-sent acks are ignored and never add credit', () => {
    const { c, s, push } = credited();
    push(1, 2, 3);
    s.ack(1);
    push(4); // seq 4: in flight now 2, 3 and 4
    push(5); // waits
    s.ack(1); // duplicate
    s.ack(1);
    s.ack(0);
    s.ack(-5);
    s.ack(99); // never sent: can't be acknowledged
    s.ack(2.5);
    s.ack(Number.NaN);
    expect(c.sent).toHaveLength(4);
    s.ack(2);
    expect(sentFrames(c).at(-1)).toEqual({ n: 5, seq: 5 });
  });

  it('grants one frame when no ack arrives for a second while credit is exhausted; late acks still count once', () => {
    const { c, s, push, advance } = credited();
    push(1, 2, 3, 4);
    advance(999);
    s.drain();
    expect(c.sent).toHaveLength(3);
    advance(1);
    s.drain();
    expect(sentFrames(c).at(-1)).toEqual({ n: 4, seq: 4 });
    push(5);
    s.ack(4);
    expect(sentFrames(c).at(-1)).toEqual({ n: 5, seq: 5 });
  });

  it('back-to-back grants back off 1 s → 2 s → 4 s → 8 s (capped); an accepted ack resets to 1 s', () => {
    const { c, s, push, advance } = credited();
    push(1, 2, 3);
    /** Keeps a frame pending and returns how long (in 100 ms steps) until the next one goes out. */
    const nextGrant = () => {
      const before = c.sent.length;
      push(100 + before);
      let waited = 0;
      while (c.sent.length === before) {
        advance(100);
        waited += 100;
        s.drain();
        if (waited > 20_000) throw new Error('never granted');
      }
      return waited;
    };
    expect([nextGrant(), nextGrant(), nextGrant(), nextGrant(), nextGrant()]).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    s.ack(c.sent.length); // the viewer is back
    push(9, 10, 11); // 3 in flight again
    expect(nextGrant()).toBe(1_000);
    expect(nextGrant()).toBe(2_000);
    s.ack(2); // stale (below what the grants already counted): no reset
    expect(nextGrant()).toBe(4_000);
  });

  it('the ack timeout counts from the send that used the last credit, not from an old quiet period', () => {
    const { c, s, push, advance } = credited();
    push(1);
    s.ack(1);
    advance(10_000); // a static page: no frames for a while
    push(2, 3, 4, 5); // credit exhausted just now: 5 waits
    expect(c.sent).toHaveLength(4);
    advance(500);
    s.drain();
    expect(c.sent).toHaveLength(4);
  });

  it('still respects the socket buffer: credit alone does not send into a backed-up socket', () => {
    const { c, s, push } = credited(600 * 1024);
    push(1);
    expect(c.sent).toHaveLength(0);
    c.bufferedAmount = 0;
    s.drain();
    expect(sentFrames(c)).toEqual([{ n: 1, seq: 1 }]);
  });

  it('clear() drops the pending frame but keeps numbering and credit (a popup switch on the same viewer)', () => {
    const { c, s, push } = credited();
    push(1, 2, 3, 4);
    s.clear();
    s.ack(3);
    expect(c.sent).toHaveLength(3);
    push(5);
    expect(sentFrames(c).at(-1)).toEqual({ n: 5, seq: 4 });
  });

  it('without negotiation nothing changes: type-1 frames, no credit limit, acks ignored', () => {
    const c = conn();
    const s = createLatestSender(c);
    const frames = [1, 2, 3, 4, 5, 6].map(jf);
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
    for (const n of [3, 4, 5, 6]) s.push(jf(n));
    expect(c.sent.slice(0, 2)).toEqual([jf(1), jf(2)]);
    expect(sentFrames(c).slice(2)).toEqual([
      { n: 3, seq: 1 },
      { n: 4, seq: 2 },
      { n: 5, seq: 3 },
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
      for (const n of [1, 2, 3, 4]) s.push(jf(n));
      t += CREDIT_ACK_TIMEOUT_MS;
      s.drain();
      expect(c.sent).toHaveLength(4);
    } finally {
      Date.now = real;
    }
  });
});
