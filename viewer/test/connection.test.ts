import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodeFrame, importE2eKey, newE2eKey, openMsg, sealMsg } from '@velmlabs/unstuck-protocol';
import { connect, e2eCodec, type Codec, type ConnectionHandlers } from '../src/connection';

class FakeWs {
  static all: FakeWs[] = [];
  binaryType = 'blob';
  sent: Uint8Array[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(b: Uint8Array) {
    this.sent.push(b);
  }
  /** What was sent, without the trailing-space padding (padding has its own test). */
  texts(): string[] {
    return this.sent.map((b) => new TextDecoder().decode(b).trimEnd());
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  /** Opens, then the engine's challenge arrives (plaintext under the pass-through codec). */
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.msg({ t: 'challenge', n: 'NONCE' });
  }
  msg(m: object) {
    this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(m)).buffer });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  hellos() {
    return this.texts().map((s) => JSON.parse(s)).filter((m) => m.t === 'hello');
  }
}

const ready = { t: 'ready', reason: 'r', site: 's', expiresAt: 9e12, resumeKey: 'RK' };
function handlers(): ConnectionHandlers & Record<string, ReturnType<typeof vi.fn>> {
  return { onReady: vi.fn(), onFrame: vi.fn(), onState: vi.fn(), onError: vi.fn(), onPhase: vi.fn() } as never;
}
/** Pass-through codec (increasing sequence numbers): the wire format is tested with the real codec below. */
let inSeq = 0;
const plain: Codec = { seal: async (_c, _s, p) => p, open: async (_c, b) => ({ seq: ++inSeq, plain: b }) };
const make = (h = handlers()) => ({ h, sock: connect('ws://x/ws/abc', 'TOK', plain, h, { WebSocketImpl: FakeWs as never }) });
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  FakeWs.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('connect', () => {
  it('sends hello with the token on open and reports ready', async () => {
    const { h } = make();
    expect(FakeWs.all[0]!.binaryType).toBe('arraybuffer');
    FakeWs.all[0]!.open();
    await flush();
    expect(FakeWs.all[0]!.hellos()).toEqual([{ t: 'hello', token: 'TOK' }]);
    FakeWs.all[0]!.msg(ready);
    await flush();
    expect(h.onReady).toHaveBeenCalledWith(ready);
    expect(h.onPhase).toHaveBeenLastCalledWith('live');
  });

  it('Final I1: a stored resumeKey is sent on the very first hello (reload / reopened link)', async () => {
    const h = handlers();
    connect('ws://x/ws/abc', 'TOK', plain, h, { WebSocketImpl: FakeWs as never, resumeKey: 'SAVED' });
    FakeWs.all[0]!.open();
    await flush();
    expect(FakeWs.all[0]!.hellos()).toEqual([{ t: 'hello', token: 'TOK', resumeKey: 'SAVED' }]);
  });

  it('decodes binary frames', async () => {
    const { h } = make();
    const ws = FakeWs.all[0]!;
    ws.open();
    await flush();
    const bytes = encodeFrame({ width: 10, height: 20, jpeg: new Uint8Array([7]) });
    ws.onmessage?.({ data: bytes.buffer });
    await flush();
    expect(h.onFrame).toHaveBeenCalledWith({ width: 10, height: 20, jpeg: new Uint8Array([7]) });
    ws.onmessage?.({ data: new Uint8Array([9]).buffer });
    await flush();
    expect(h.onFrame).toHaveBeenCalledTimes(1);
  });

  it('send() only writes while open', async () => {
    const { sock } = make();
    sock.send({ t: 'done' });
    expect(FakeWs.all[0]!.sent).toEqual([]);
    FakeWs.all[0]!.open();
    await flush();
    sock.send({ t: 'done' });
    await flush();
    expect(FakeWs.all[0]!.texts().at(-1)).toBe('{"t":"done"}');
  });

  it('pings every 20 s while open', async () => {
    make();
    FakeWs.all[0]!.open();
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWs.all[0]!.texts().at(-1)).toBe('{"t":"ping"}');
  });

  it('after ready, a dropped socket reconnects with the resumeKey using backoff', async () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    await flush();
    FakeWs.all[0]!.msg(ready);
    await flush();
    FakeWs.all[0]!.drop();
    expect(h.onPhase).toHaveBeenLastCalledWith('reconnecting');
    vi.advanceTimersByTime(499);
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(2);
    FakeWs.all[1]!.open();
    await flush();
    expect(FakeWs.all[1]!.hellos()).toEqual([{ t: 'hello', token: 'TOK', resumeKey: 'RK' }]);
    FakeWs.all[1]!.drop();
    vi.advanceTimersByTime(1000);
    expect(FakeWs.all).toHaveLength(3);
  });

  it('keeps trying for 5 minutes (long enough to fetch a code from another app), then gives up', async () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    await flush();
    FakeWs.all[0]!.msg(ready);
    await flush();
    FakeWs.all[0]!.drop();
    for (let i = 0; i < 70; i++) {
      vi.advanceTimersByTime(4000);
      FakeWs.all.at(-1)!.drop();
    }
    expect(h.onPhase).not.toHaveBeenCalledWith('closed'); // 280 s
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(4000);
      FakeWs.all.at(-1)!.drop();
    }
    expect(h.onPhase).toHaveBeenLastCalledWith('closed');
    const count = FakeWs.all.length;
    vi.advanceTimersByTime(10_000);
    expect(FakeWs.all).toHaveLength(count);
  });

  it('a failed reconnect asks whether the session still exists: when it has ended, it stops at once', async () => {
    const h = handlers();
    let answer = true;
    const alive = vi.fn(async () => answer);
    connect('ws://x/ws/abc', 'TOK', plain, h, { WebSocketImpl: FakeWs as never, alive });
    FakeWs.all[0]!.open();
    await flush();
    FakeWs.all[0]!.msg(ready);
    await flush();
    FakeWs.all[0]!.drop();
    await flush();
    expect(alive).toHaveBeenCalledTimes(1);
    expect(h.onPhase).toHaveBeenLastCalledWith('reconnecting');
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWs.all).toHaveLength(2);
    answer = false;
    FakeWs.all[1]!.drop();
    await flush();
    expect(h.onPhase).toHaveBeenLastCalledWith('ended');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeWs.all).toHaveLength(2);
  });

  it('only one existence check runs at a time', async () => {
    let release: (v: boolean) => void = () => {};
    const alive = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    connect('ws://x/ws/abc', 'TOK', plain, handlers(), { WebSocketImpl: FakeWs as never, alive });
    FakeWs.all[0]!.drop();
    await vi.advanceTimersByTimeAsync(500);
    FakeWs.all[1]!.drop();
    await flush();
    expect(alive).toHaveBeenCalledTimes(1);
    release(true);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    FakeWs.all[2]!.drop();
    await flush();
    expect(alive).toHaveBeenCalledTimes(2);
  });

  it('wake() (page visible again, network back) retries at once instead of waiting out the backoff', async () => {
    const { h, sock } = make();
    FakeWs.all[0]!.open();
    await flush();
    FakeWs.all[0]!.msg(ready);
    await flush();
    sock.wake();
    expect(FakeWs.all).toHaveLength(1); // live: nothing to do
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(4000);
      FakeWs.all.at(-1)!.drop();
    }
    const n = FakeWs.all.length;
    sock.wake();
    expect(FakeWs.all).toHaveLength(n + 1);
    vi.advanceTimersByTime(4000);
    expect(FakeWs.all).toHaveLength(n + 1); // the pending retry was replaced, not doubled
    expect(h.onPhase).toHaveBeenLastCalledWith('reconnecting');
  });

  it('wake() after giving up does nothing', async () => {
    const { sock } = make();
    sock.close();
    sock.wake();
    expect(FakeWs.all).toHaveLength(1);
  });

  it('a socket that drops before ready also retries (link not yet redeemed)', async () => {
    make();
    FakeWs.all[0]!.drop();
    vi.advanceTimersByTime(500);
    expect(FakeWs.all).toHaveLength(2);
  });

  it('a fatal error stops reconnecting and is reported', async () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    await flush();
    FakeWs.all[0]!.msg({ t: 'error', code: 'token_used', message: 'm' });
    await flush();
    FakeWs.all[0]!.drop();
    vi.advanceTimersByTime(10_000);
    expect(h.onError).toHaveBeenCalledWith('token_used', 'm');
    expect(FakeWs.all).toHaveLength(1);
  });

  it('bad_message is reported but not fatal', async () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    await flush();
    FakeWs.all[0]!.msg({ t: 'error', code: 'bad_message', message: 'm' });
    await flush();
    FakeWs.all[0]!.drop();
    vi.advanceTimersByTime(500);
    expect(h.onError).toHaveBeenCalledWith('bad_message', 'm');
    expect(FakeWs.all).toHaveLength(2);
  });

  it('a terminal state stops reconnecting', async () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    await flush();
    FakeWs.all[0]!.msg(ready);
    await flush();
    FakeWs.all[0]!.msg({ t: 'state', status: 'resolved' });
    await flush();
    FakeWs.all[0]!.drop();
    vi.advanceTimersByTime(10_000);
    expect(h.onState).toHaveBeenCalledWith('resolved');
    expect(FakeWs.all).toHaveLength(1);
  });

  it('ignores pong and malformed JSON', async () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    await flush();
    FakeWs.all[0]!.msg({ t: 'pong' });
    await flush();
    FakeWs.all[0]!.onmessage?.({ data: new TextEncoder().encode('{not json').buffer });
    await flush();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('close() stops everything', async () => {
    const { sock } = make();
    FakeWs.all[0]!.open();
    await flush();
    sock.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(1);
  });

  it('defaults to the global WebSocket', async () => {
    const G = globalThis as { WebSocket?: unknown };
    const prev = G.WebSocket;
    G.WebSocket = FakeWs;
    try {
      connect('ws://x/ws/abc', 'TOK', plain, handlers());
      expect(FakeWs.all).toHaveLength(1);
    } finally {
      G.WebSocket = prev;
    }
  });

  it('code_required and code_invalid ask for the code without stopping', async () => {
    const h = { ...handlers(), onCodeRequest: vi.fn() } as never as ConnectionHandlers & Record<string, ReturnType<typeof vi.fn>>;
    const { sock } = make(h);
    const ws = FakeWs.all[0]!;
    ws.open();
    await flush();
    ws.msg({ t: 'error', code: 'code_required', message: 'm' });
    await flush();
    expect(h.onCodeRequest).toHaveBeenLastCalledWith(false);
    ws.msg({ t: 'error', code: 'code_invalid', message: 'm' });
    await flush();
    expect(h.onCodeRequest).toHaveBeenLastCalledWith(true);
    expect(h.onError).not.toHaveBeenCalled();
    sock.sendHello('123456');
    await flush();
    expect(ws.hellos().at(-1)).toEqual({ t: 'hello', token: 'TOK', code: '123456' });
    ws.drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWs.all).toHaveLength(2);
  });

  it('the give-up window restarts after every successful ready', async () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    await flush();
    FakeWs.all[0]!.msg(ready);
    await flush();
    for (const _ of [1, 2]) {
      FakeWs.all.at(-1)!.drop();
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(4000);
        FakeWs.all.at(-1)!.drop();
      }
      await vi.advanceTimersByTimeAsync(4000);
      FakeWs.all.at(-1)!.open();
      await flush();
      FakeWs.all.at(-1)!.msg(ready);
      await flush();
    }
    expect(h.onPhase).not.toHaveBeenCalledWith('closed');
  });

  it('with the real codec: waits for the challenge, then seals hello with its nonce; replays are ignored', async () => {
    const raw = newE2eKey();
    const key = await importE2eKey(raw);
    const h = handlers();
    vi.useRealTimers();
    connect('ws://x/ws/abc', 'TOK', e2eCodec(key, 'SID'), h, { WebSocketImpl: FakeWs as never });
    const ws = FakeWs.all[0]!;
    ws.readyState = 1;
    ws.onopen?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.sent).toHaveLength(0); // nothing before the challenge
    const enc = (m: object) => new TextEncoder().encode(JSON.stringify(m));
    ws.onmessage?.({ data: (await sealMsg(key, 'SID', 'e2v', '', 0, enc({ t: 'challenge', n: 'N1' }))).buffer });
    await new Promise((r) => setTimeout(r, 20));
    const hello = await openMsg(key, 'SID', 'v2e', 'N1', ws.sent[0]!);
    expect(JSON.parse(new TextDecoder().decode(hello!.plain))).toEqual({ t: 'hello', token: 'TOK' });
    const readyMsg = await sealMsg(key, 'SID', 'e2v', 'N1', 1, enc(ready));
    ws.onmessage?.({ data: readyMsg.buffer });
    ws.onmessage?.({ data: readyMsg.slice().buffer }); // replayed by the relay
    ws.onmessage?.({ data: (await sealMsg(key, 'SID', 'e2v', 'OTHER', 2, enc(ready))).buffer }); // another connection's
    await new Promise((r) => setTimeout(r, 20));
    expect(h.onReady).toHaveBeenCalledTimes(1);
  });

  it('native typing: the field map and focus reports reach their handlers; older viewers just ignore them', async () => {
    const h = { ...handlers(), onFields: vi.fn(), onFocus: vi.fn() };
    connect('ws://x/ws/abc', 'TOK', plain, h, { WebSocketImpl: FakeWs as never });
    FakeWs.all[0]!.open();
    await flush();
    FakeWs.all[0]!.msg(ready);
    FakeWs.all[0]!.msg({ t: 'fields', fields: [{ x: 1, y: 2, w: 3, h: 4, kind: 'otp' }] });
    FakeWs.all[0]!.msg({ t: 'focus', kind: 'email' });
    await flush();
    expect(h.onFields).toHaveBeenCalledWith([{ x: 1, y: 2, w: 3, h: 4, kind: 'otp' }]);
    expect(h.onFocus).toHaveBeenCalledWith('email', undefined);
    const old = handlers(); // no onFields/onFocus
    connect('ws://x/ws/abc', 'TOK', plain, old, { WebSocketImpl: FakeWs as never });
    FakeWs.all[1]!.open();
    await flush();
    FakeWs.all[1]!.msg({ t: 'fields', fields: [] });
    FakeWs.all[1]!.msg({ t: 'focus', kind: null });
    await flush();
    expect(old.onError).not.toHaveBeenCalled();
  });
});

describe('anti-replay with engines that echo (challenge v: 2)', () => {
  const v2 = (ws: FakeWs) => {
    ws.readyState = 1;
    ws.onopen?.();
    ws.msg({ t: 'challenge', n: 'NONCE', v: 2 });
  };
  it('sends a fresh random vn in each hello', async () => {
    const { } = make();
    v2(FakeWs.all[0]!);
    await flush();
    const vn = FakeWs.all[0]!.hellos()[0].vn;
    expect(vn).toMatch(/^[A-Za-z0-9_-]{22}$/);
    FakeWs.all[0]!.drop();
    vi.advanceTimersByTime(500);
    v2(FakeWs.all[1]!);
    await flush();
    expect(FakeWs.all[1]!.hellos()[0].vn).not.toBe(vn);
  });
  it('a ready that does not echo our vn is a replay: not live, the socket is dropped, and earlier state is ignored', async () => {
    const { h } = make();
    const ws = FakeWs.all[0]!;
    v2(ws);
    await flush();
    ws.msg({ t: 'state', status: 'resolved' }); // replayed from an old connection, before any ready
    ws.msg({ ...ready, vn: 'OLD'.padEnd(22, 'x') });
    await flush();
    expect(h.onState).not.toHaveBeenCalled();
    expect(h.onReady).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(3);
  });
  it('a ready that echoes our vn goes live', async () => {
    const { h } = make();
    const ws = FakeWs.all[0]!;
    v2(ws);
    await flush();
    ws.msg({ ...ready, vn: ws.hellos()[0].vn });
    await flush();
    expect(h.onReady).toHaveBeenCalled();
    ws.msg({ t: 'state', status: 'active' });
    await flush();
    expect(h.onState).toHaveBeenCalledWith('active');
  });
  it('an older engine (challenge without v) is accepted as before, with no vn in the hello', async () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    await flush();
    expect(FakeWs.all[0]!.hellos()[0]).not.toHaveProperty('vn');
    FakeWs.all[0]!.msg(ready);
    await flush();
    expect(h.onReady).toHaveBeenCalled();
  });
  it('pads what it sends to at least 256 bytes, so sizes do not tell keys or text lengths', async () => {
    const { sock } = make();
    FakeWs.all[0]!.open();
    await flush();
    sock.send({ t: 'text', text: 'hunter2' });
    sock.send({ t: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 });
    await flush();
    expect(FakeWs.all[0]!.sent.map((b) => b.length)).toEqual([256, 256, 256]);
  });
});

describe('long text', () => {
  it('a long paste goes as several text messages, each small enough for the relay once sealed', async () => {
    const { sock } = make();
    FakeWs.all[0]!.open();
    await flush();
    const text = 'é'.repeat(40_000) + '😀'.repeat(10);
    sock.send({ t: 'text', text });
    await flush();
    const sent = FakeWs.all[0]!.texts().slice(1).map((t) => JSON.parse(t));
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((m) => m.t === 'text')).toBe(true);
    expect(sent.map((m) => m.text).join('')).toBe(text);
    expect(Math.max(...FakeWs.all[0]!.sent.map((b) => b.length))).toBeLessThanOrEqual(65_504);
  });

  describe('frame credit', () => {
    const live = async (readyMsg: object) => {
      const { h, sock } = make();
      const ws = FakeWs.all[0]!;
      ws.open();
      await flush();
      ws.msg(readyMsg);
      await flush();
      return { h, sock, ws, texts: () => ws.texts().map((t) => JSON.parse(t)) };
    };
    const frameBytes = (seq?: number) => encodeFrame({ width: 10, height: 20, jpeg: new Uint8Array([7]) }, seq);

    it('opts in when ready announces credit, and passes frame sequence numbers on', async () => {
      const { h, ws, texts } = await live({ ...ready, credit: 1 });
      expect(texts().filter((m) => m.t === 'credit')).toEqual([{ t: 'credit', v: 1 }]);
      ws.onmessage?.({ data: frameBytes(5).buffer });
      await flush();
      expect(h.onFrame).toHaveBeenCalledWith({ width: 10, height: 20, jpeg: new Uint8Array([7]), seq: 5 });
    });

    it('never opts in with an engine that does not announce credit (older engines refuse unknown messages)', async () => {
      const { texts } = await live(ready);
      expect(texts().map((m) => m.t)).toEqual(['hello']);
    });

    it('ack() sends the frame\'s sequence number on the socket it came from', async () => {
      const { h, sock, texts } = await live({ ...ready, credit: 1 });
      FakeWs.all[0]!.onmessage?.({ data: frameBytes(3).buffer });
      await flush();
      sock.ack(vi.mocked(h.onFrame).mock.calls[0]![0]);
      await flush();
      expect(texts().at(-1)).toEqual({ t: 'ack', seq: 3 });
    });

    it('ack() ignores frames without a sequence number and frames from a replaced socket', async () => {
      const { h, sock, ws, texts } = await live({ ...ready, credit: 1 });
      ws.onmessage?.({ data: frameBytes().buffer });
      ws.onmessage?.({ data: frameBytes(9).buffer });
      await flush();
      const [plainFrame, old] = vi.mocked(h.onFrame).mock.calls.map((c) => c[0]);
      sock.ack(plainFrame!);
      sock.ack({ width: 1, height: 1, jpeg: new Uint8Array(), seq: 1 }); // not one this connection delivered
      await flush();
      expect(texts().filter((m) => m.t === 'ack')).toEqual([]);
      ws.drop();
      await vi.advanceTimersByTimeAsync(500);
      const ws2 = FakeWs.all[1]!;
      ws2.open();
      await flush();
      ws2.msg({ ...ready, credit: 1 });
      await flush();
      sock.ack(old!); // drawn after the reconnect: its number means nothing to the new connection
      await flush();
      expect(ws2.texts().map((t) => JSON.parse(t).t)).toEqual(['hello', 'credit']);
    });
  });
});
