import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodeFrame } from '@unstuck/protocol';
import { connect, type ConnectionHandlers } from '../src/connection';

class FakeWs {
  static all: FakeWs[] = [];
  binaryType = 'blob';
  sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  msg(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  hellos() {
    return this.sent.map((s) => JSON.parse(s)).filter((m) => m.t === 'hello');
  }
}

const ready = { t: 'ready', reason: 'r', site: 's', expiresAt: 9e12, resumeKey: 'RK' };
function handlers(): ConnectionHandlers & Record<string, ReturnType<typeof vi.fn>> {
  return { onReady: vi.fn(), onFrame: vi.fn(), onState: vi.fn(), onError: vi.fn(), onPhase: vi.fn() } as never;
}
const make = (h = handlers()) => ({ h, sock: connect('ws://x/ws/abc', 'TOK', h, { WebSocketImpl: FakeWs as never }) });

beforeEach(() => {
  FakeWs.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('connect', () => {
  it('sends hello with the token on open and reports ready', () => {
    const { h } = make();
    expect(FakeWs.all[0]!.binaryType).toBe('arraybuffer');
    FakeWs.all[0]!.open();
    expect(FakeWs.all[0]!.hellos()).toEqual([{ t: 'hello', token: 'TOK' }]);
    FakeWs.all[0]!.msg(ready);
    expect(h.onReady).toHaveBeenCalledWith(ready);
    expect(h.onPhase).toHaveBeenLastCalledWith('live');
  });

  it('Final I1: a stored resumeKey is sent on the very first hello (reload / reopened link)', () => {
    const h = handlers();
    connect('ws://x/ws/abc', 'TOK', h, { WebSocketImpl: FakeWs as never, resumeKey: 'SAVED' });
    FakeWs.all[0]!.open();
    expect(FakeWs.all[0]!.hellos()).toEqual([{ t: 'hello', token: 'TOK', resumeKey: 'SAVED' }]);
  });

  it('decodes binary frames', () => {
    const { h } = make();
    const ws = FakeWs.all[0]!;
    ws.open();
    const bytes = encodeFrame({ width: 10, height: 20, jpeg: new Uint8Array([7]) });
    ws.onmessage?.({ data: bytes.buffer });
    expect(h.onFrame).toHaveBeenCalledWith({ width: 10, height: 20, jpeg: new Uint8Array([7]) });
    ws.onmessage?.({ data: new Uint8Array([9]).buffer });
    expect(h.onFrame).toHaveBeenCalledTimes(1);
  });

  it('send() only writes while open', () => {
    const { sock } = make();
    sock.send({ t: 'done' });
    expect(FakeWs.all[0]!.sent).toEqual([]);
    FakeWs.all[0]!.open();
    sock.send({ t: 'done' });
    expect(FakeWs.all[0]!.sent.at(-1)).toBe('{"t":"done"}');
  });

  it('pings every 20 s while open', () => {
    make();
    FakeWs.all[0]!.open();
    vi.advanceTimersByTime(20_000);
    expect(FakeWs.all[0]!.sent.at(-1)).toBe('{"t":"ping"}');
  });

  it('after ready, a dropped socket reconnects with the resumeKey using backoff', () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.msg(ready);
    FakeWs.all[0]!.drop();
    expect(h.onPhase).toHaveBeenLastCalledWith('reconnecting');
    vi.advanceTimersByTime(499);
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWs.all).toHaveLength(2);
    FakeWs.all[1]!.open();
    expect(FakeWs.all[1]!.hellos()).toEqual([{ t: 'hello', token: 'TOK', resumeKey: 'RK' }]);
    FakeWs.all[1]!.drop();
    vi.advanceTimersByTime(1000);
    expect(FakeWs.all).toHaveLength(3);
  });

  it('gives up reconnecting after 60 s', () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.msg(ready);
    FakeWs.all[0]!.drop();
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(4000);
      FakeWs.all.at(-1)!.drop();
    }
    expect(h.onPhase).toHaveBeenLastCalledWith('closed');
    const count = FakeWs.all.length;
    vi.advanceTimersByTime(10_000);
    expect(FakeWs.all).toHaveLength(count);
  });

  it('a socket that drops before ready also retries (link not yet redeemed)', () => {
    make();
    FakeWs.all[0]!.drop();
    vi.advanceTimersByTime(500);
    expect(FakeWs.all).toHaveLength(2);
  });

  it('a fatal error stops reconnecting and is reported', () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.msg({ t: 'error', code: 'token_used', message: 'm' });
    FakeWs.all[0]!.drop();
    vi.advanceTimersByTime(10_000);
    expect(h.onError).toHaveBeenCalledWith('token_used', 'm');
    expect(FakeWs.all).toHaveLength(1);
  });

  it('bad_message is reported but not fatal', () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.msg({ t: 'error', code: 'bad_message', message: 'm' });
    FakeWs.all[0]!.drop();
    vi.advanceTimersByTime(500);
    expect(h.onError).toHaveBeenCalledWith('bad_message', 'm');
    expect(FakeWs.all).toHaveLength(2);
  });

  it('a terminal state stops reconnecting', () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.msg(ready);
    FakeWs.all[0]!.msg({ t: 'state', status: 'resolved' });
    FakeWs.all[0]!.drop();
    vi.advanceTimersByTime(10_000);
    expect(h.onState).toHaveBeenCalledWith('resolved');
    expect(FakeWs.all).toHaveLength(1);
  });

  it('ignores pong and malformed JSON', () => {
    const { h } = make();
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.msg({ t: 'pong' });
    FakeWs.all[0]!.onmessage?.({ data: 'not json' });
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('close() stops everything', () => {
    const { sock } = make();
    FakeWs.all[0]!.open();
    sock.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(1);
  });

  it('defaults to the global WebSocket', () => {
    const G = globalThis as { WebSocket?: unknown };
    const prev = G.WebSocket;
    G.WebSocket = FakeWs;
    try {
      connect('ws://x/ws/abc', 'TOK', handlers());
      expect(FakeWs.all).toHaveLength(1);
    } finally {
      G.WebSocket = prev;
    }
  });
});
