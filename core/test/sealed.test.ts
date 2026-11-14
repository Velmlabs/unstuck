import { describe, it, expect } from 'vitest';
import { newE2eKey, importE2eKey, openMsg, sealMsg } from '@velmlabs/unstuck-protocol';
import { FakeViewer } from '../src/testing';
import { sealConnection } from '../src/session/sealed';
import { settle } from './settle';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function setup() {
  const key = await importE2eKey(newE2eKey());
  const raw = new FakeViewer();
  const conn = sealConnection(raw, key, 'S1');
  const got: (string | Uint8Array)[] = [];
  conn.onMessage((m) => got.push(m));
  await settle();
  // The first thing on the wire is the challenge carrying this connection's nonce.
  const challenge = await openMsg(key, 'S1', 'e2v', '', raw.sent[0] as Uint8Array);
  const n = JSON.parse(dec(challenge!.plain)).n as string;
  let seq = 0;
  const sealIn = (p: Uint8Array, s = ++seq) => sealMsg(key, 'S1', 'v2e', n, s, p);
  const openOut = async (i: number) => (await openMsg(key, 'S1', 'e2v', n, raw.sent[i] as Uint8Array))!;
  return { key, raw, conn, got, n, sealIn, openOut };
}

describe('sealConnection', () => {
  it('opens with a sealed challenge carrying a fresh connection nonce', async () => {
    const a = await setup();
    const b = await setup();
    expect(a.n).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.n).not.toBe(b.n);
  });

  it('delivers sealed JSON as a string and frames as bytes', async () => {
    const t = await setup();
    t.raw.push(await t.sealIn(enc('{"t":"ping"}')));
    t.raw.push(await t.sealIn(new Uint8Array([1, 2, 3])));
    await settle();
    expect(t.got).toEqual(['{"t":"ping"}', new Uint8Array([1, 2, 3])]);
  });

  it('seals what the engine sends, strings and bytes, in order, with increasing sequence numbers', async () => {
    const t = await setup();
    t.conn.send(new Uint8Array(200_000).fill(1));
    t.conn.send('{"t":"pong"}');
    await settle();
    expect(t.raw.sent).toHaveLength(3);
    const a = await t.openOut(1);
    const b = await t.openOut(2);
    expect(a.plain.length).toBe(200_000);
    expect(dec(b.plain)).toBe('{"t":"pong"}');
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it('Final #8: a message replayed within the connection is refused', async () => {
    const t = await setup();
    const click = await t.sealIn(enc('{"t":"done"}'));
    t.raw.push(click);
    t.raw.push(click);
    await settle();
    expect(t.got).toEqual(['{"t":"done"}']);
    expect(t.raw.closed?.code).toBe(1008);
  });

  it('Final #8: a message recorded on another connection does not open on this one', async () => {
    const first = await setup();
    const recorded = await first.sealIn(enc('{"t":"done"}'));
    // Replay into a fresh connection (different nonce): nothing is delivered.
    const fresh = new FakeViewer();
    const conn3 = sealConnection(fresh, first.key, 'S1');
    const got3: unknown[] = [];
    conn3.onMessage((m) => got3.push(m));
    fresh.push(recorded);
    await settle();
    expect(got3).toEqual([]);
    expect(fresh.closed?.code).toBe(1008);
  });

  it('gaps in sequence numbers are fine (a relay may drop frames), going backwards is not', async () => {
    const t = await setup();
    t.raw.push(await t.sealIn(enc('{"t":"ping"}'), 5));
    t.raw.push(await t.sealIn(enc('{"t":"ping"}'), 9));
    t.raw.push(await t.sealIn(enc('{"t":"ping"}'), 7));
    await settle();
    expect(t.got).toHaveLength(2);
    expect(t.raw.closed?.code).toBe(1008);
  });

  it('send followed by close delivers the message before closing', async () => {
    const t = await setup();
    t.conn.send('{"t":"error","code":"token_invalid","message":"x"}');
    t.conn.close(1008, 'token_invalid');
    await settle();
    expect(t.raw.sent).toHaveLength(2);
    expect(t.raw.closed?.code).toBe(1008);
  });

  it('counts messages still being sealed in bufferedAmount', async () => {
    const t = await setup();
    t.raw.bufferedAmount = 10;
    t.conn.send(new Uint8Array(1000));
    expect(t.conn.bufferedAmount).toBeGreaterThanOrEqual(1010);
    await settle();
    expect(t.conn.bufferedAmount).toBe(10);
  });

  it('after close: sends are ignored, late messages are dropped, a second close is a no-op', async () => {
    const t = await setup();
    const late = await t.sealIn(enc('{"t":"ping"}'));
    t.conn.close(1000);
    t.conn.close(1000);
    t.conn.send('{"t":"x"}');
    t.raw.push(late);
    await settle();
    expect(t.raw.sent).toHaveLength(1); // just the challenge
    expect(t.got).toEqual([]);
  });

  it('a text message from the wire is treated as bytes and must still open', async () => {
    const t = await setup();
    t.raw.push('{"t":"hello"}');
    await settle();
    expect(t.raw.closed?.code).toBe(1008);
  });

  it('the remote closing stops delivery of messages still being opened', async () => {
    const t = await setup();
    let closed = 0;
    t.conn.onClose(() => closed++);
    t.raw.push(await t.sealIn(enc('{"t":"ping"}')));
    t.raw.close(1006);
    await settle();
    expect(closed).toBe(1);
    expect(t.got).toEqual([]);
  });
});
