import { describe, it, expect } from 'vitest';
import { newE2eKey, importE2eKey, seal, open } from '@unstuck/protocol';
import { FakeViewer } from '../src/testing';
import { sealConnection } from '../src/session/sealed';

const enc = (s: string) => new TextEncoder().encode(s);
const tick = () => new Promise((r) => setTimeout(r, 20));

async function setup() {
  const key = await importE2eKey(newE2eKey());
  const raw = new FakeViewer();
  const conn = sealConnection(raw, key, 'S1');
  const got: (string | Uint8Array)[] = [];
  conn.onMessage((m) => got.push(m));
  return { key, raw, conn, got };
}

describe('sealConnection', () => {
  it('delivers a sealed JSON message as the same string', async () => {
    const t = await setup();
    t.raw.push(await seal(t.key, 'S1', 'v2e', enc('{"t":"ping"}')));
    await tick();
    expect(t.got).toEqual(['{"t":"ping"}']);
  });

  it('delivers a sealed frame as bytes', async () => {
    const t = await setup();
    t.raw.push(await seal(t.key, 'S1', 'v2e', new Uint8Array([1, 2, 3])));
    await tick();
    expect(t.got).toEqual([new Uint8Array([1, 2, 3])]);
  });

  it('seals what the engine sends, strings and bytes, in order', async () => {
    const t = await setup();
    t.conn.send(new Uint8Array(200_000).fill(1));
    t.conn.send('{"t":"pong"}');
    await tick();
    expect(t.raw.sent).toHaveLength(2);
    const opened = await Promise.all(t.raw.sent.map((s) => open(t.key, 'S1', 'e2v', s as Uint8Array)));
    expect(opened[0]!.length).toBe(200_000);
    expect(new TextDecoder().decode(opened[1]!)).toBe('{"t":"pong"}');
  });

  it('keeps arrival order when a large message is followed by a small one', async () => {
    const t = await setup();
    t.raw.push(await seal(t.key, 'S1', 'v2e', new Uint8Array(60_000).fill(1)));
    t.raw.push(await seal(t.key, 'S1', 'v2e', enc('{"t":"ping"}')));
    await tick();
    expect(t.got[1]).toBe('{"t":"ping"}');
  });

  it('closes with 1008 on a message that does not open, and sends nothing', async () => {
    const t = await setup();
    t.raw.push(enc('{"t":"hello","token":"x"}'));
    await tick();
    expect(t.raw.closed?.code).toBe(1008);
    expect(t.raw.sent).toEqual([]);
    expect(t.got).toEqual([]);
  });

  it('counts messages still being sealed in bufferedAmount', async () => {
    const t = await setup();
    t.raw.bufferedAmount = 10;
    t.conn.send(new Uint8Array(1000));
    expect(t.conn.bufferedAmount).toBeGreaterThanOrEqual(1010);
    await tick();
    expect(t.conn.bufferedAmount).toBe(10);
  });

  it('send followed by close delivers the message before closing', async () => {
    const t = await setup();
    t.conn.send('{"t":"error","code":"token_invalid","message":"x"}');
    t.conn.close(1008, 'token_invalid');
    await tick();
    expect(t.raw.sent).toHaveLength(1);
    expect(t.raw.closed?.code).toBe(1008);
  });

  it('after close: sends are ignored, late messages are dropped, a second close is a no-op', async () => {
    const t = await setup();
    const late = await seal(t.key, 'S1', 'v2e', enc('{"t":"ping"}'));
    t.conn.close(1000);
    t.conn.close(1000);
    t.conn.send('{"t":"x"}');
    t.raw.push(late);
    await tick();
    expect(t.raw.sent).toEqual([]);
    expect(t.got).toEqual([]);
  });

  it('a text message from the wire is treated as bytes and must still open', async () => {
    const t = await setup();
    t.raw.push('{"t":"hello"}');
    await tick();
    expect(t.raw.closed?.code).toBe(1008);
  });

  it('messages queued behind a bad one are not delivered', async () => {
    const t = await setup();
    t.raw.push(new Uint8Array(40));
    t.raw.push(await seal(t.key, 'S1', 'v2e', enc('{"t":"ping"}')));
    await tick();
    expect(t.got).toEqual([]);
  });

  it('the remote closing stops delivery of messages still being opened', async () => {
    const t = await setup();
    let closed = 0;
    t.conn.onClose(() => closed++);
    t.raw.push(await seal(t.key, 'S1', 'v2e', enc('{"t":"ping"}')));
    t.raw.close(1006);
    await tick();
    expect(closed).toBe(1);
    expect(t.got).toEqual([]);
  });
});
