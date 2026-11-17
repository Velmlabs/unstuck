import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeEnvelope, encodeEnvelope, importE2eKey, newE2eKey, openMsg } from '@velmlabs/unstuck-protocol';
import { createRelayTransport, RelayError } from '../src/relay-transport';
import { createEngine, type LinkInfo } from '../src/engine';
import { FakeCdp } from '../src/testing';
import { sealConnection } from '../src/session/sealed';
import { createLatestSender } from '../src/stream/latest';
import type { ViewerConnection } from '../src/transport';

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  binaryType = 'blob';
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeWs.all.push(this);
  }
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
  // relay side
  accept() {
    this.readyState = 1;
    this.onopen?.();
  }
  text(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  bin(b: Uint8Array) {
    this.onmessage?.({ data: b.slice().buffer });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }
  json() {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d));
  }
}

const ID = 'SESSION_0123456789ab';
const make = (agentKey?: string) => createRelayTransport({ url: 'wss://r.test', agentKey, WebSocketImpl: FakeWs as never });
const flush = () => vi.advanceTimersByTimeAsync(0);
const realSetTimeout = globalThis.setTimeout;
/** Waits on real time: Web Crypto runs off the fake clock. */
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => realSetTimeout(r, 5));
}

async function published(agentKey = 'K') {
  const t = make(agentKey);
  const p = t.publish(ID, { expiresAt: 5_000 });
  const ws = FakeWs.all.at(-1)!;
  ws.accept();
  ws.text({ t: 'registered' });
  await expect(p).resolves.toEqual({ baseUrl: `https://r.test/s/${ID}` });
  return { t, ws };
}

beforeEach(() => {
  FakeWs.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('createRelayTransport', () => {
  it('publish opens /agent/<id> with the subprotocols, says hello and resolves once registered', async () => {
    const { ws } = await published();
    expect(ws.url).toBe(`wss://r.test/agent/${ID}`);
    expect(ws.protocols).toEqual(['unstuck-relay.1', 'key.K']);
    expect(ws.binaryType).toBe('arraybuffer');
    const hello = ws.json()[0];
    expect(hello).toMatchObject({ t: 'hello', expiresAt: 5_000 });
    expect(hello.secret).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('without a key offers only the relay subprotocol; ws:// maps to http://', async () => {
    const t = createRelayTransport({ url: 'ws://localhost:8787/', WebSocketImpl: FakeWs as never });
    const p = t.publish(ID, { expiresAt: 1 });
    FakeWs.all[0]!.accept();
    FakeWs.all[0]!.text({ t: 'registered' });
    expect(FakeWs.all[0]!.protocols).toEqual(['unstuck-relay.1']);
    await expect(p).resolves.toEqual({ baseUrl: `http://localhost:8787/s/${ID}` });
  });

  it('with a viewer URL, links open the pinned viewer and name the relay in ?r= (the secret stays in the fragment)', async () => {
    const t = createRelayTransport({ url: 'wss://relay.unstuck.sh', viewerUrl: 'https://view.unstuck.sh/v/1.2.3/', WebSocketImpl: FakeWs as never });
    const p = t.publish(ID, { expiresAt: 1 });
    FakeWs.all[0]!.accept();
    FakeWs.all[0]!.text({ t: 'registered' });
    await expect(p).resolves.toEqual({ baseUrl: `https://view.unstuck.sh/v/1.2.3/s/${ID}?r=wss%3A%2F%2Frelay.unstuck.sh` });
  });

  it('relay open/close and envelopes become viewer connections', async () => {
    const { t, ws } = await published();
    const conns: ViewerConnection[] = [];
    t.onConnection(ID, (c) => conns.push(c));
    ws.text({ t: 'open', c: 3 });
    expect(conns).toHaveLength(1);
    const got: unknown[] = [];
    let closed = 0;
    conns[0]!.onMessage((m) => got.push(m));
    conns[0]!.onClose(() => closed++);
    ws.bin(encodeEnvelope(3, new Uint8Array([1, 2])));
    ws.bin(encodeEnvelope(4, new Uint8Array([9])));
    expect(got).toEqual([new Uint8Array([1, 2])]);
    conns[0]!.send(new Uint8Array([7]));
    conns[0]!.send('{"t":"x"}');
    const sentBins = ws.sent.filter((d): d is Uint8Array => d instanceof Uint8Array).map(decodeEnvelope);
    expect(sentBins[0]).toEqual({ c: 3, payload: new Uint8Array([7]) });
    expect(new TextDecoder().decode(sentBins[1]!.payload)).toBe('{"t":"x"}');
    ws.bufferedAmount = 77;
    expect(conns[0]!.bufferedAmount).toBe(77);
    ws.text({ t: 'close', c: 3 });
    expect(closed).toBe(1);
  });

  it("a socket without bufferedAmount (Workers' client WebSocket) reads as 0, so frames are not held back forever", async () => {
    const { t, ws } = await published();
    (ws as { bufferedAmount?: number }).bufferedAmount = undefined;
    const conns: ViewerConnection[] = [];
    t.onConnection(ID, (c) => conns.push(c));
    ws.text({ t: 'open', c: 3 });
    expect(conns[0]!.bufferedAmount).toBe(0);
  });

  it('frames flow through sealConnection and createLatestSender on a socket without bufferedAmount (no NaN stall)', async () => {
    const { t, ws } = await published();
    (ws as { bufferedAmount?: number }).bufferedAmount = undefined;
    const conns: ViewerConnection[] = [];
    t.onConnection(ID, (c) => conns.push(c));
    ws.text({ t: 'open', c: 3 });
    const key = await importE2eKey(newE2eKey());
    const sealed = sealConnection(conns[0]!, key, ID);
    const frames = createLatestSender(sealed);
    frames.push(new Uint8Array([1, 2, 3]));
    frames.push(new Uint8Array([4, 5]));
    const envelopes = () => ws.sent.filter((d): d is Uint8Array => d instanceof Uint8Array).map((d) => decodeEnvelope(d)!);
    await until(() => envelopes().length === 3); // challenge + both frames
    const challenge = await openMsg(key, ID, 'e2v', '', envelopes()[0]!.payload);
    const n = JSON.parse(new TextDecoder().decode(challenge!.plain)).n as string;
    const last = await openMsg(key, ID, 'e2v', n, envelopes()[2]!.payload);
    expect(last!.plain).toEqual(new Uint8Array([4, 5]));
  });

  it('binary messages delivered as Blob (Workers client sockets) are handled, in order with text', async () => {
    const { t, ws } = await published();
    const got: unknown[] = [];
    let closed = false;
    t.onConnection(ID, (c) => {
      c.onMessage((m) => got.push(m));
      c.onClose(() => (closed = true));
    });
    ws.text({ t: 'open', c: 1 });
    ws.onmessage?.({ data: new Blob([encodeEnvelope(1, new Uint8Array([5])).slice().buffer]) });
    ws.text({ t: 'close', c: 1 });
    await vi.waitFor(() => expect(closed).toBe(true));
    expect(got).toEqual([new Uint8Array([5])]);
  });

  it('closing a viewer from the engine tells the relay and fires onClose once', async () => {
    const { t, ws } = await published();
    let conn!: ViewerConnection;
    t.onConnection(ID, (c) => (conn = c));
    ws.text({ t: 'open', c: 1 });
    let closed = 0;
    conn.onClose(() => closed++);
    conn.close(1008, 'x');
    conn.close(1008, 'x');
    expect(ws.json()).toContainEqual({ t: 'close', c: 1, code: 1008 });
    expect(closed).toBe(1);
  });

  it('ignores a quick_answer frame: it is never treated as a new viewer connection', async () => {
    const { ws } = await published();
    ws.text({ t: 'quick_answer', choice: 1 });
    await new Promise((r) => realSetTimeout(r, 0));
    ws.text({ t: 'ping' });
    expect(ws.json()).toContainEqual({ t: 'pong' });
    expect(ws.readyState).toBe(1);
  });

  it('answers ping with pong; unpublish sends end and closes', async () => {
    const { t, ws } = await published();
    ws.text({ t: 'ping' });
    expect(ws.json()).toContainEqual({ t: 'pong' });
    await t.unpublish(ID);
    expect(ws.json().at(-1)).toEqual({ t: 'end' });
    expect(ws.readyState).toBe(3);
  });

  it.each([
    [4401, 'relay_unauthorized'],
    [4403, 'relay_unauthorized'],
    [4402, 'relay_quota_exceeded'],
    [4429, 'relay_rate_limited'],
    [1006, 'relay_unreachable'],
  ])('a relay refusal (close %i) rejects publish with %s', async (code, detail) => {
    const t = make('K');
    const p = t.publish(ID, { expiresAt: 1 });
    FakeWs.all[0]!.accept();
    FakeWs.all[0]!.drop(code);
    await expect(p).rejects.toMatchObject({ detail });
    await expect(p).rejects.toBeInstanceOf(RelayError);
  });

  it('no registration within 15 s rejects with relay_unreachable', async () => {
    const t = make('K');
    const p = t.publish(ID, { expiresAt: 1 });
    const settled = expect(p).rejects.toMatchObject({ detail: 'relay_unreachable' });
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    expect(FakeWs.all[0]!.readyState).toBe(3);
  });

  it('Review Focus 1: a drop reports down, retries with backoff and the same secret, then up', async () => {
    const { t, ws } = await published();
    const statuses: string[] = [];
    t.onStatus(ID, (s) => statuses.push(s));
    let conn!: ViewerConnection;
    t.onConnection(ID, (c) => (conn = c));
    ws.text({ t: 'open', c: 1 });
    let closed = false;
    conn.onClose(() => (closed = true));
    ws.drop();
    expect(statuses).toEqual(['down']);
    expect(closed).toBe(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWs.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWs.all).toHaveLength(2);
    FakeWs.all[1]!.drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWs.all).toHaveLength(3);
    const third = FakeWs.all[2]!;
    third.accept();
    expect(third.json()[0].secret).toBe(ws.json()[0].secret);
    third.text({ t: 'registered' });
    expect(statuses).toEqual(['down', 'up']);
    third.text({ t: 'open', c: 2 });
    expect(conn).toBeDefined();
  });

  it('backoff caps at 30 s, and a 4409 (session taken) stops retrying', async () => {
    const { ws } = await published();
    ws.drop();
    for (let i = 0; i < 10; i++) {
      const before = FakeWs.all.length;
      while (FakeWs.all.length === before) await vi.advanceTimersByTimeAsync(100);
      FakeWs.all.at(-1)!.drop();
    }
    const n = FakeWs.all.length;
    await vi.advanceTimersByTimeAsync(29_800);
    expect(FakeWs.all.length).toBe(n);
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeWs.all.length).toBe(n + 1);
    FakeWs.all.at(-1)!.drop(4409);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeWs.all.length).toBe(n + 1);
  });

  it('Final #4: unpublish during a reconnect closes the connecting socket, and a late registration is ended', async () => {
    const { t, ws } = await published();
    ws.drop();
    await vi.advanceTimersByTimeAsync(500);
    const connecting = FakeWs.all[1]!;
    expect(connecting.readyState).toBe(0);
    await t.unpublish(ID);
    expect(connecting.readyState).toBe(3);
    // A relay that registers it anyway gets an immediate end.
    connecting.readyState = 1;
    connecting.text({ t: 'registered' });
    expect(connecting.json().at(-1)).toEqual({ t: 'end' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWs.all).toHaveLength(2);
  });

  it('Final #4: close() while the first publish is still connecting closes that socket', async () => {
    const t = make('K');
    const p = t.publish(ID, { expiresAt: 1 });
    await t.close();
    expect(FakeWs.all[0]!.readyState).toBe(3);
    await expect(p).rejects.toBeInstanceOf(RelayError);
  });

  it('close() unpublishes every session', async () => {
    const { t, ws } = await published();
    await t.close();
    expect(ws.json().at(-1)).toEqual({ t: 'end' });
  });

  it('defaults to the global WebSocket', () => {
    const G = globalThis as { WebSocket?: unknown };
    const prev = G.WebSocket;
    G.WebSocket = FakeWs;
    try {
      void createRelayTransport({ url: 'wss://r.test' }).publish(ID, { expiresAt: 1 }).catch(() => {});
      expect(FakeWs.all).toHaveLength(1);
    } finally {
      G.WebSocket = prev;
    }
  });
});

describe('in-process engine over the relay transport', () => {
  it('a relay refusal becomes a failed result with the relay detail', async () => {
    const engine = createEngine({ transport: make('BAD') });
    const r = engine.takeover(new FakeCdp(), { reason: 'x', timeoutS: 60 });
    await until(() => FakeWs.all.length > 0);
    FakeWs.all[0]!.accept();
    FakeWs.all[0]!.drop(4401);
    await expect(r).resolves.toMatchObject({ status: 'failed', detail: 'relay_unauthorized' });
  });

  it('a takeover runs end to end through the relay transport', async () => {
    const links: LinkInfo[] = [];
    const engine = createEngine({ transport: make('K'), onLink: (l) => links.push(l) });
    const r = engine.takeover(new FakeCdp(), { reason: 'x', timeoutS: 60 });
    await until(() => FakeWs.all.length > 0);
    const ws = FakeWs.all[0]!;
    ws.accept();
    ws.text({ t: 'registered' });
    await until(() => links.length > 0);
    expect(links[0]!.url).toMatch(/^https:\/\/r\.test\/s\/[A-Za-z0-9_-]{22}#t=[^&]+&k=/);
    await engine.close();
    await expect(r).resolves.toMatchObject({ status: 'cancelled' });
    expect(ws.json().at(-1)).toEqual({ t: 'end' });
  });
});
