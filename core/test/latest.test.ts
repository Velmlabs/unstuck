import { describe, it, expect } from 'vitest';
import { createLatestSender } from '../src/stream/latest';

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
