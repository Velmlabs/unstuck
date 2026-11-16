// Viewer input is queued and replayed in order; once the takeover ends (Done, Can't solve, timeout, cancel) nothing
// more from it may reach the page, and the page lock is only removed after the last dispatch has settled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeCdp, FakeTransport } from '../src/testing';
import { createEngine, type LinkInfo } from '../src/engine';
import { MemoryEventLog } from '../src/events';
import { MAX_PENDING_INPUT } from '../src/session/takeover';
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import { settle } from './settle';

const realSetTimeout = globalThis.setTimeout;
const realWait = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

type Gate = () => void;

/**
 * `slowMs`: every Input.* call takes that long (real time). `gated`: every Input.* call waits until the test opens it.
 */
function setup(opts: { slowMs?: number; gated?: boolean } = {}) {
  const transport = new FakeTransport();
  const cdp = new FakeCdp();
  cdp.respond('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'MAIN', url: 'https://shop.example.com/login' } } }));
  const gates: Gate[] = [];
  let probing = true; // the capability probe's own input must not be slowed or gated
  const delay = () => {
    if (probing) return {};
    if (opts.gated) return new Promise<object>((r) => gates.push(() => r({})));
    return opts.slowMs ? realWait(opts.slowMs).then(() => ({})) : {};
  };
  for (const m of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']) cdp.respond(m, delay);
  const log = new MemoryEventLog();
  const links: LinkInfo[] = [];
  const engine = createEngine({ transport, log, onLink: (l) => links.push(l) });
  let result: TakeoverResult | undefined;
  const running = engine.takeover(cdp, { reason: 'Solve it', timeoutS: 60 }).then((r) => (result = r));
  let joinedAt = 0;
  const join = async () => {
    probing = false;
    joinedAt = cdp.calls.length; // the capability probe's own mouseMoved is not the viewer's
    const token = new URLSearchParams(new URL(links[0]!.url).hash.slice(1)).get('t')!;
    const v = transport.connect(links[0]!.url);
    v.push({ t: 'hello', token });
    await settle();
    return v;
  };
  const inputCalls = () => cdp.calls.slice(joinedAt).filter((c) => c.method.startsWith('Input.'));
  /** Input.* calls made after the page lock was removed. */
  const afterUnlock = () => {
    const i = cdp.methods().indexOf('Fetch.disable');
    return i < 0 ? [] : cdp.calls.slice(i).filter((c) => c.method.startsWith('Input.'));
  };
  const openAll = async () => {
    for (let i = 0; i < 1000 && (gates.length || !result); i++) {
      gates.splice(0).forEach((g) => g());
      await settle();
      await vi.advanceTimersByTimeAsync(100);
    }
  };
  return { cdp, log, join, running, inputCalls, afterUnlock, gates, openAll, result: () => result, engine };
}

const mouse = (action: 'down' | 'up' | 'move', x = 1, y = 1) => ({ t: 'mouse', action, x, y, button: action === 'move' ? 'none' : 'left', clickCount: 1, modifiers: 0 });
const pressedTypes = (t: ReturnType<typeof setup>) =>
  t.inputCalls().filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => (c.params as { type: string }).type);

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('input after the takeover ends', () => {
  it('reproduced scenario: 20 clicks then Done over a 20 ms CDP round trip: nothing reaches the page after unlocking', async () => {
    const t = setup({ slowMs: 20 });
    await settle();
    const v = await t.join();
    for (let i = 0; i < 10; i++) v.push(mouse('down')), v.push(mouse('up'));
    v.push({ t: 'done' });
    await settle();
    for (let i = 0; i < 50 && !t.result(); i++) {
      await realWait(25);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(t.result()).toMatchObject({ status: 'resolved' });
    expect(t.cdp.methods()).toContain('Fetch.disable');
    expect(t.afterUnlock()).toEqual([]);
    await realWait(500); // the old queue would still be dispatching here
    expect(t.afterUnlock()).toEqual([]);
    // At most the one dispatch already in flight when Done arrived (plus a release if it was a press) ran.
    expect(pressedTypes(t).length).toBeLessThanOrEqual(2);
  });

  it("the in-flight dispatch settles before unlocking; the rest is discarded (Can't solve)", async () => {
    const t = setup({ gated: true });
    await settle();
    const v = await t.join();
    v.push({ t: 'text', text: 'a' });
    v.push({ t: 'text', text: 'b' });
    v.push({ t: 'text', text: 'c' });
    await settle();
    v.push({ t: 'cant_solve' });
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(t.cdp.methods()).not.toContain('Fetch.disable'); // still waiting on the in-flight insertText
    expect(t.result()).toBeUndefined();
    await t.openAll();
    expect(t.result()).toMatchObject({ status: 'cancelled' });
    expect(t.inputCalls().map((c) => c.params)).toEqual([{ text: 'a' }]);
    expect(t.afterUnlock()).toEqual([]);
    expect(t.log.events.at(-1)).toMatchObject({ type: 'finished', data: { inputCount: 1, inputDropped: 2 } });
  });

  it('an in-flight dispatch that never answers cannot hold the result past the stop timeout', async () => {
    const t = setup({ gated: true });
    await settle();
    const v = await t.join();
    v.push({ t: 'text', text: 'a' });
    await settle();
    v.push({ t: 'done' });
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(t.result()).toMatchObject({ status: 'resolved' });
  });

  it('input arriving after Done is dropped', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.push({ t: 'done' });
    v.push(mouse('down'));
    v.push({ t: 'text', text: 'late' });
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(t.result()).toMatchObject({ status: 'resolved' });
    expect(t.inputCalls()).toEqual([]);
  });

  it('a timeout (or cancel) discards queued input the same way', async () => {
    const t = setup({ gated: true });
    await settle();
    const v = await t.join();
    for (let i = 0; i < 5; i++) v.push({ t: 'text', text: String(i) });
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await t.openAll();
    expect(t.result()).toMatchObject({ status: 'timed_out' });
    expect(t.inputCalls().map((c) => c.params)).toEqual([{ text: '0' }]);
    expect(t.afterUnlock()).toEqual([]);
  });

  it('the text fallback stops between key presses once the takeover has ended', async () => {
    const t = setup({ gated: true });
    // no insertText: text goes out one key at a time
    t.cdp.respond('Input.insertText', () => Promise.reject(new Error('not supported')));
    await settle();
    const v = await t.join();
    v.push({ t: 'text', text: 'secret' });
    await settle();
    expect(t.inputCalls()).toHaveLength(1);
    v.push({ t: 'done' });
    await settle();
    await t.openAll();
    expect(t.inputCalls().filter((c) => c.method === 'Input.dispatchKeyEvent')).toHaveLength(1);
    expect(t.afterUnlock()).toEqual([]);
  });

  it("a departed viewer's queued input is dropped", async () => {
    const t = setup({ gated: true });
    await settle();
    const v = await t.join();
    v.push({ t: 'text', text: 'a' });
    v.push({ t: 'text', text: 'b' });
    await settle();
    v.close();
    for (let i = 0; i < 5; i++) {
      gatesOpen(t);
      await settle();
    }
    expect(t.inputCalls().map((c) => c.params)).toEqual([{ text: 'a' }]);
    t.engine.close();
  });
});

function gatesOpen(t: ReturnType<typeof setup>) {
  t.gates.splice(0).forEach((g) => g());
}

describe('a pressed button is never left stuck', () => {
  it('a press in flight when Done arrives is released before the page is unlocked', async () => {
    const t = setup({ gated: true });
    await settle();
    const v = await t.join();
    v.push(mouse('move', 3, 4));
    v.push(mouse('down', 5, 6));
    v.push(mouse('up', 5, 6)); // queued behind the press: discarded
    await settle();
    gatesOpen(t); // the move lands; the press is now in flight
    await settle();
    v.push({ t: 'done' });
    await settle();
    await t.openAll();
    const methods = t.cdp.methods();
    const release = t.cdp.calls.findIndex((c) => (c.params as { type?: string })?.type === 'mouseReleased');
    expect(pressedTypes(t)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(t.cdp.calls[release]!.params).toMatchObject({ x: 5, y: 6, button: 'left' });
    expect(release).toBeLessThan(methods.indexOf('Fetch.disable'));
  });

  it('a drag still pressed when the takeover is cancelled is released where the pointer last was', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.push(mouse('down', 5, 6));
    v.push(mouse('move', 7, 8));
    await settle();
    t.engine.close();
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(t.result()).toMatchObject({ status: 'cancelled' });
    expect(pressedTypes(t)).toEqual(['mousePressed', 'mouseMoved', 'mouseReleased']);
    expect(t.cdp.calls.find((c) => (c.params as { type?: string })?.type === 'mouseReleased')!.params).toMatchObject({ x: 7, y: 8 });
  });

  it('no release is sent when nothing is pressed', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.push(mouse('down'));
    v.push(mouse('up'));
    await settle();
    v.push({ t: 'done' });
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(pressedTypes(t)).toEqual(['mousePressed', 'mouseReleased']);
  });
});

describe('the input queue is bounded', () => {
  it(`holds at most ${MAX_PENDING_INPUT} messages: pointer moves and wheels go first, then new input is dropped`, async () => {
    const t = setup({ gated: true });
    await settle();
    const v = await t.join();
    v.push({ t: 'text', text: 'first' }); // in flight, not pending
    await settle();
    v.push(mouse('move', 1, 1));
    v.push({ t: 'wheel', x: 1, y: 1, dx: 0, dy: 5 });
    for (let i = 0; i < MAX_PENDING_INPUT - 2; i++) v.push({ t: 'text', text: `k${i}` });
    await settle();
    v.push({ t: 'text', text: 'over1' }); // evicts the move
    v.push({ t: 'text', text: 'over2' }); // evicts the wheel
    v.push({ t: 'text', text: 'over3' }); // nothing to evict: dropped
    await settle();
    for (let i = 0; i < 1000 && t.gates.length; i++) {
      gatesOpen(t);
      await settle();
    }
    const texts = t.inputCalls().filter((c) => c.method === 'Input.insertText').map((c) => (c.params as { text: string }).text);
    expect(texts).toEqual(['first', ...Array.from({ length: MAX_PENDING_INPUT - 2 }, (_, i) => `k${i}`), 'over1', 'over2']);
    expect(pressedTypes(t)).toEqual([]);
    v.push({ t: 'done' });
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();
    expect(t.log.events.at(-1)).toMatchObject({ type: 'finished', data: { inputDropped: 3 } });
  });

  it('a release is never dropped for being over the cap: it takes the place of an older pending press or key', async () => {
    const t = setup({ gated: true });
    await settle();
    const v = await t.join();
    v.push(mouse('down', 2, 2)); // in flight: this press is dispatched
    await settle();
    for (let i = 0; i < MAX_PENDING_INPUT; i++) v.push({ t: 'text', text: `k${i}` });
    await settle();
    v.push(mouse('up', 2, 2));
    await settle();
    for (let i = 0; i < 1000 && t.gates.length; i++) {
      gatesOpen(t);
      await settle();
    }
    expect(pressedTypes(t)).toEqual(['mousePressed', 'mouseReleased']);
    const texts = t.inputCalls().filter((c) => c.method === 'Input.insertText');
    expect(texts).toHaveLength(MAX_PENDING_INPUT - 1);
    expect(texts[0]!.params).toEqual({ text: 'k1' });
  });

  it('a queue full of releases drops a further release (one is already on its way)', async () => {
    const t = setup({ gated: true });
    await settle();
    const v = await t.join();
    v.push(mouse('down', 2, 2));
    await settle();
    for (let i = 0; i <= MAX_PENDING_INPUT; i++) v.push(mouse('up', 2, 2));
    await settle();
    for (let i = 0; i < 1000 && t.gates.length; i++) {
      gatesOpen(t);
      await settle();
    }
    expect(pressedTypes(t).filter((x) => x === 'mouseReleased')).toHaveLength(MAX_PENDING_INPUT);
  });
});
