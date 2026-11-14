import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeCdp, FakeTransport, type FakeViewer } from '../src/testing';
import { createEngine, type LinkInfo } from '../src/engine';
import { MemoryEventLog } from '../src/events';
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import { settle } from './settle';

const frame = { data: 'AQID', sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 720 } };

function setup(opts: { timeoutS?: number } = {}) {
  return setupWith(() => {}, opts);
}

function setupWith(prepare: (cdp: FakeCdp) => void, opts: { timeoutS?: number } = {}) {
  const transport = new FakeTransport();
  const cdp = new FakeCdp();
  prepare(cdp);
  const log = new MemoryEventLog();
  const links: LinkInfo[] = [];
  const engine = createEngine({ transport, log, onLink: (l) => links.push(l) });
  let result: TakeoverResult | undefined;
  const done = engine.takeover(cdp, { reason: 'Solve the CAPTCHA', site: 'shop.example', timeoutS: opts.timeoutS }).then((r) => (result = r));
  const token = () => new URLSearchParams(new URL(links[0]!.url).hash.slice(1)).get('t')!;
  const join = async (extra: object = {}) => {
    const v = transport.connect(links[0]!.url);
    v.push({ t: 'hello', token: token(), ...extra });
    await settle();
    return v;
  };
  return { transport, cdp, log, links, engine, done, token, join, result: () => result };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('takeover session', () => {
  it('happy path: link → join → frames → input → done → resolved', async () => {
    const t = setup();
    await settle();
    expect(t.links).toHaveLength(1);
    expect(t.links[0]).toMatchObject({ reason: 'Solve the CAPTCHA' });
    expect(t.links[0]!.url).toMatch(/^http:\/\/fake\.test\/s\/[A-Za-z0-9_-]{22}#t=/);

    const v = await t.join();
    const ready = v.json()[0];
    expect(ready).toMatchObject({ t: 'ready', reason: 'Solve the CAPTCHA', site: 'shop.example' });
    expect(typeof ready.resumeKey).toBe('string');
    expect(t.cdp.methods()).toContain('Page.startScreencast');

    t.cdp.emit('Page.screencastFrame', frame);
    await settle();
    expect(v.binary()[0]![0]).toBe(0x01);
    expect(Array.from(v.binary()[0]!.slice(1, 5))).toEqual([0x05, 0x00, 0x02, 0xd0]); // 1280, 720

    v.push({ t: 'mouse', action: 'down', x: 5, y: 6, button: 'left', clickCount: 1, modifiers: 0 });
    v.push({ t: 'mouse', action: 'up', x: 5, y: 6, button: 'left', clickCount: 1, modifiers: 0 });
    await settle();
    // (the capability probe adds one harmless mouseMoved at 0,0)
    expect(t.cdp.calls.filter((c) => c.method === 'Input.dispatchMouseEvent' && (c.params as { type: string }).type !== 'mouseMoved')).toHaveLength(2);

    v.push({ t: 'done' });
    await settle();
    await t.done;
    expect(t.result()).toMatchObject({ status: 'resolved', sessionId: t.links[0]!.sessionId, url: t.links[0]!.url });
    expect(t.transport.unpublished).toEqual([t.links[0]!.sessionId]);
    expect(t.cdp.methods()).toContain('Page.stopScreencast');
    expect(v.json().at(-1)).toEqual({ t: 'state', status: 'resolved' });
    expect(v.closed).not.toBeNull();
  });

  it('answers ping with pong and rejects malformed messages without closing', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.push({ t: 'ping' });
    v.push('not json');
    v.push(new Uint8Array([1]));
    await settle();
    expect(v.json().slice(1)).toEqual([{ t: 'pong' }, { t: 'error', code: 'bad_message', message: expect.any(String) }, { t: 'error', code: 'bad_message', message: expect.any(String) }]);
    expect(v.closed).toBeNull();
  });

  it('Review Focus 2: a second viewer with the same token is rejected; the holder is unaffected', async () => {
    const t = setup();
    await settle();
    const first = await t.join();
    const second = await t.join();
    expect(second.json()).toEqual([{ t: 'error', code: 'token_used', message: expect.any(String) }]);
    expect(second.closed).not.toBeNull();
    t.cdp.emit('Page.screencastFrame', frame);
    await settle();
    expect(first.binary()).toHaveLength(1);
    first.push({ t: 'done' });
    await settle();
    await t.done;
    expect(t.result()!.status).toBe('resolved');
  });

  it('rejects a bad token with token_invalid', async () => {
    const t = setup();
    await settle();
    const v = t.transport.connect(t.links[0]!.url);
    v.push({ t: 'hello', token: 'nope.nope' });
    await settle();
    expect(v.json()).toEqual([{ t: 'error', code: 'token_invalid', message: expect.any(String) }]);
    expect(v.closed).not.toBeNull();
  });

  it('rejects a valid token from another session', async () => {
    const transport = new FakeTransport();
    const links: LinkInfo[] = [];
    const engine = createEngine({ transport, onLink: (l) => links.push(l) });
    void engine.takeover(new FakeCdp(), { reason: 'a' });
    void engine.takeover(new FakeCdp(), { reason: 'b' });
    await settle();
    const otherToken = new URL(links[1]!.url).hash.replace('#t=', '');
    const v = transport.connect(links[0]!.url);
    v.push({ t: 'hello', token: otherToken });
    await settle();
    expect(v.json()[0]).toMatchObject({ t: 'error', code: 'token_invalid' });
    await engine.close();
  });

  it('a message other than hello first closes the connection', async () => {
    const t = setup();
    await settle();
    const v = t.transport.connect(t.links[0]!.url);
    v.push({ t: 'done' });
    await settle();
    expect(v.json()[0]).toMatchObject({ t: 'error', code: 'bad_message' });
    expect(v.closed).not.toBeNull();
    expect(t.result()).toBeUndefined();
  });

  it('Review Focus 3: the page closing mid-takeover fails immediately with page_closed', async () => {
    const t = setup();
    await settle();
    await t.join();
    t.cdp.close('detached');
    await settle();
    expect(t.result()).toMatchObject({ status: 'failed', detail: 'page_closed' });
  });

  it('Review Focus 5: nobody joins → timed_out at the timeout, unpublished, no timers left', async () => {
    const t = setup();
    await settle();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(t.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(t.result()).toMatchObject({ status: 'timed_out' });
    expect(t.result()!.durationS).toBeCloseTo(600, 0);
    expect(t.transport.unpublished).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('timeout while a viewer is active stops the screencast and tells the viewer', async () => {
    const t = setup({ timeoutS: 5 });
    await settle();
    const v = await t.join();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(t.result()).toMatchObject({ status: 'timed_out' });
    expect(v.json().at(-1)).toEqual({ t: 'state', status: 'timed_out' });
    expect(t.cdp.methods()).toContain('Page.stopScreencast');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a viewer joining after expiry gets expired', async () => {
    const t = setup({ timeoutS: 5 });
    await settle();
    const v = t.transport.connect(t.links[0]!.url);
    vi.setSystemTime(Date.now() + 5_000);
    v.push({ t: 'hello', token: t.token() });
    await settle();
    expect(v.json()[0]).toMatchObject({ t: 'error', code: 'expired' });
  });

  it('resume: reconnect within 60 s with the resumeKey continues the session', async () => {
    const t = setup();
    await settle();
    const v1 = await t.join();
    const resumeKey = v1.json()[0].resumeKey;
    const before = t.cdp.calls.length;
    v1.close();
    await settle();
    expect(t.cdp.methods().slice(before).filter((m) => m === 'Page.stopScreencast')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    const v2 = await t.join({ resumeKey });
    expect(v2.json()[0]).toMatchObject({ t: 'ready' });
    expect(t.cdp.methods().slice(before).filter((m) => m === 'Page.startScreencast')).toHaveLength(1);
  });

  it('resume after the 60 s window finds the takeover already ended', async () => {
    const t = setup();
    await settle();
    const v1 = await t.join();
    const resumeKey = v1.json()[0].resumeKey;
    v1.close();
    await vi.advanceTimersByTimeAsync(61_000);
    await settle();
    expect(t.result()).toMatchObject({ status: 'failed', detail: 'viewer_left' });
  });

  it('a reconnect with the right resumeKey replaces a stale connection that never closed', async () => {
    const t = setup();
    await settle();
    const v1 = await t.join();
    const resumeKey = v1.json()[0].resumeKey;
    const v2 = await t.join({ resumeKey });
    expect(v2.json()[0]).toMatchObject({ t: 'ready' });
    expect(v1.closed).not.toBeNull();
    t.cdp.emit('Page.screencastFrame', frame);
    await settle();
    expect(v2.binary()).toHaveLength(1);
  });

  it('Review Focus 5 (2a): no screencast and no insertText → takeover still works via fallbacks and says so', async () => {
    const t = setupWith((cdp) => {
      cdp.respond('Page.startScreencast', () => Promise.reject(new Error('not supported')));
      cdp.respond('Input.insertText', () => Promise.reject(new Error('not supported')));
      cdp.respond('Page.getLayoutMetrics', () => ({ cssVisualViewport: { clientWidth: 800, clientHeight: 600 } }));
      cdp.respond('Page.captureScreenshot', () => ({ data: 'AQID' }));
    });
    await settle();
    const v = await t.join();
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    expect(v.binary().length).toBeGreaterThan(0);
    expect(Array.from(v.binary()[0]!.slice(1, 5))).toEqual([0x03, 0x20, 0x02, 0x58]); // 800, 600
    v.push({ t: 'text', text: 'ok' });
    await settle();
    expect(t.cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent')).toHaveLength(4);
    v.push({ t: 'done' });
    await settle();
    expect(t.result()).toMatchObject({ status: 'resolved', detail: 'fallback: screenshots, per-key typing' });
    expect(t.log.events[0]).toMatchObject({ type: 'created', data: { screencast: false, insertText: false, input: true } });
  });

  it('a browser without input support fails before any link is published', async () => {
    const t = setupWith((cdp) => cdp.respond('Input.dispatchMouseEvent', () => Promise.reject(new Error('no input'))));
    await settle();
    expect(t.result()).toMatchObject({ status: 'failed', detail: 'browser does not support input' });
    expect(t.links).toHaveLength(0);
    expect(t.transport.published.size).toBe(0);
  });

  it('a page closing during the probe reports page_closed, not missing input', async () => {
    const t = setupWith((cdp) =>
      cdp.respond('Input.dispatchMouseEvent', () => {
        cdp.close('detached');
        return Promise.reject(new Error('detached'));
      }),
    );
    await settle();
    expect(t.result()).toMatchObject({ status: 'failed', detail: 'page_closed' });
  });

  it('Final I2: a replacing viewer immediately gets the last frame even if the page never repaints', async () => {
    const t = setup();
    await settle();
    const v1 = await t.join();
    t.cdp.emit('Page.screencastFrame', frame);
    await settle();
    const resumeKey = v1.json()[0].resumeKey;
    const v2 = await t.join({ resumeKey });
    expect(v2.binary()).toHaveLength(1);
    expect(v2.binary()[0]![0]).toBe(0x01);
  });

  it('Final I2: a viewer resuming after a disconnect also gets the last frame', async () => {
    const t = setup();
    await settle();
    const v1 = await t.join();
    t.cdp.emit('Page.screencastFrame', frame);
    await settle();
    const resumeKey = v1.json()[0].resumeKey;
    v1.close();
    await settle();
    const v2 = await t.join({ resumeKey });
    expect(v2.binary().length).toBeGreaterThanOrEqual(1);
  });

  it('Final M2: finish() resolves even if Page.stopScreencast never answers', async () => {
    const t = setup();
    let stops = 0;
    t.cdp.respond('Page.stopScreencast', () => (stops++ === 0 ? {} : new Promise(() => {}))); // the probe's stop answers
    await settle();
    const v = await t.join();
    v.push({ t: 'done' });
    await settle();
    expect(t.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(t.result()).toMatchObject({ status: 'resolved' });
  });

  it('Final I1: if the holder leaves and does not come back within 60 s, the takeover ends as failed/viewer_left', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.close();
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(t.result()).toMatchObject({ status: 'failed', detail: 'viewer_left' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('Final I1: a resume within 60 s cancels the viewer_left deadline', async () => {
    const t = setup();
    await settle();
    const v1 = await t.join();
    const resumeKey = v1.json()[0].resumeKey;
    v1.close();
    await vi.advanceTimersByTimeAsync(59_000);
    await t.join({ resumeKey });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.result()).toBeUndefined();
  });

  it('a connection that never says hello is closed after 10 s; the session keeps waiting', async () => {
    const t = setup();
    await settle();
    const v = t.transport.connect(t.links[0]!.url);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle(); // the close is queued behind the challenge's encryption
    expect(v.closed).not.toBeNull();
    expect(t.result()).toBeUndefined();
    const v2 = await t.join();
    expect(v2.json()[0]).toMatchObject({ t: 'ready' });
  });

  it("can't solve → cancelled with the human's reason (default cant_solve)", async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.push({ t: 'cant_solve', reason: 'image unclear' });
    await settle();
    expect(t.result()).toMatchObject({ status: 'cancelled', detail: 'image unclear' });

    const t2 = setup();
    await settle();
    const v2 = await t2.join();
    v2.push({ t: 'cant_solve' });
    await settle();
    expect(t2.result()).toMatchObject({ status: 'cancelled', detail: 'cant_solve' });
  });

  it('log privacy: typed text and the token never reach the event log', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.push({ t: 'text', text: 'hunter2' });
    v.push({ t: 'key', action: 'down', key: 'x', code: 'KeyX', text: 'x', modifiers: 0 });
    v.push({ t: 'key', action: 'up', key: 'x', code: 'KeyX', modifiers: 0 });
    await settle();
    v.push({ t: 'done' });
    await settle();
    const dump = JSON.stringify(t.log.events);
    expect(dump).not.toContain('hunter2');
    expect(dump).not.toContain(t.token());
    expect(t.log.events.at(-1)).toMatchObject({ type: 'finished', data: { status: 'resolved', inputCount: 3 } });
    expect(t.log.events.map((e) => e.type)).toEqual(expect.arrayContaining(['created', 'published', 'link', 'viewer_joined', 'finished']));
  });

  it('input that fails in CDP fails the session with cdp_error', async () => {
    const t = setup();
    await settle();
    t.cdp.respond('Input.insertText', () => Promise.reject(new Error('Target crashed')));
    const v = await t.join();
    v.push({ t: 'text', text: 'x' });
    await settle();
    expect(t.result()).toMatchObject({ status: 'failed', detail: 'cdp_error: Target crashed' });
  });

  it('a screencast that cannot start fails the session with cdp_error', async () => {
    const t = setup();
    let starts = 0;
    // Passes the capability probe, then fails when the viewer joins.
    t.cdp.respond('Page.startScreencast', () => (starts++ === 0 ? {} : Promise.reject(new Error('not supported'))));
    await settle();
    await t.join();
    expect(t.result()).toMatchObject({ status: 'failed', detail: 'cdp_error: not supported' });
  });

  it('a slow viewer only gets the newest frame once it drains', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.raw.bufferedAmount = 10 * 1024 * 1024; // backpressure is on the wire connection
    t.cdp.emit('Page.screencastFrame', { ...frame, data: 'AQ==' });
    await settle();
    t.cdp.emit('Page.screencastFrame', { ...frame, data: 'Ag==' });
    await settle();
    expect(v.binary()).toHaveLength(0);
    v.raw.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    expect(v.binary()).toHaveLength(1);
    expect(v.binary()[0]![5]).toBe(2);
  });

  it('engine.close() cancels a waiting takeover with engine_closed and closes the transport', async () => {
    const t = setup();
    await settle();
    await t.engine.close();
    await settle();
    expect(t.result()).toMatchObject({ status: 'cancelled', detail: 'engine_closed' });
    expect(t.transport.closed).toBe(true);
  });

  it('a publish failure becomes a failed result, never a rejection', async () => {
    const transport = new FakeTransport();
    transport.publish = () => Promise.reject(new Error('port in use'));
    const engine = createEngine({ transport });
    await expect(engine.takeover(new FakeCdp(), { reason: 'x' })).resolves.toMatchObject({ status: 'failed', detail: 'publish_error: port in use' });
  });

  it('a page that is already closed fails before publishing', async () => {
    const transport = new FakeTransport();
    const cdp = new FakeCdp();
    const engine = createEngine({ transport });
    const p = engine.takeover(cdp, { reason: 'x' });
    cdp.close('gone');
    await expect(p).resolves.toMatchObject({ status: 'failed', detail: 'page_closed' });
  });

  it('uses the engine default timeout and a per-call onLink over the engine one', async () => {
    const transport = new FakeTransport();
    const engineLinks: LinkInfo[] = [];
    const callLinks: LinkInfo[] = [];
    const engine = createEngine({ transport, defaultTimeoutS: 2, onLink: (l) => engineLinks.push(l), secret: new Uint8Array(32) });
    const p = engine.takeover(new FakeCdp(), { reason: 'x', onLink: (l) => callLinks.push(l) });
    await settle();
    expect(callLinks).toHaveLength(1);
    expect(engineLinks).toHaveLength(0);
    expect(callLinks[0]!.expiresAt - Date.now()).toBe(2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toMatchObject({ status: 'timed_out' });
  });
});

describe('end-to-end encryption', () => {
  it('the link carries a 32-byte key after the token', async () => {
    const t = setup();
    await settle();
    expect(t.links[0]!.url).toMatch(/#t=[^&]+&k=[A-Za-z0-9_-]{43}$/);
    t.engine.close();
  });

  it('a viewer with the wrong key is closed with 1008 and gets nothing', async () => {
    const t = setup();
    await settle();
    const wrong = t.links[0]!.url.replace(/k=[^&]+$/, 'k=' + 'A'.repeat(43));
    const v = t.transport.connect(wrong);
    v.push({ t: 'hello', token: t.token() });
    await settle();
    expect(v.raw.closed?.code).toBe(1008);
    expect(v.raw.sent).toHaveLength(1); // only the challenge, which that key can't read
    t.engine.close();
  });

  it('everything on the wire is ciphertext', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    t.cdp.emit('Page.screencastFrame', frame);
    await settle();
    expect(v.raw.sent.length).toBeGreaterThan(1);
    for (const m of v.raw.sent) {
      expect(m).toBeInstanceOf(Uint8Array);
      expect([0x7b, 0x01]).not.toContain((m as Uint8Array)[0]);
    }
    t.engine.close();
  });

  it('Review Focus 1: a transport outage pauses the viewer-left timer', async () => {
    const t = setup({ timeoutS: 600 });
    await settle();
    const v = await t.join();
    const resumeKey = v.json()[0].resumeKey;
    const id = t.links[0]!.sessionId;
    t.transport.setStatus(id, 'down');
    v.close();
    await settle();
    await vi.advanceTimersByTimeAsync(90_000);
    t.transport.setStatus(id, 'up');
    await settle();
    expect(t.result()).toBeUndefined();
    const v2 = t.transport.connect(t.links[0]!.url);
    v2.push({ t: 'hello', token: t.token(), resumeKey });
    await settle();
    expect(v2.json()[0]).toMatchObject({ t: 'ready' });
    v2.push({ t: 'done' });
    await settle();
    await t.done;
    expect(t.result()?.status).toBe('resolved');
  });
});

describe('messages that arrive while the hello is still being handled', () => {
  it('a Done tapped as soon as the screen appears is not lost', async () => {
    const held: (() => void)[] = [];
    const t = setup();
    await settle();
    // (the capability probe already ran) hold the stream start, as a real browser takes a moment
    t.cdp.respond('Page.startScreencast', () => new Promise<object>((r) => held.push(() => r({}))));
    const v = t.transport.connect(t.links[0]!.url);
    v.push({ t: 'hello', token: t.token() });
    v.push({ t: 'done' }); // the human taps Done before the stream finished starting
    await settle();
    held.splice(0).forEach((r) => r());
    await settle();
    await t.done;
    expect(t.result()?.status).toBe('resolved');
  });

  it('messages after a refused hello are still treated as a new hello', async () => {
    const t = setup();
    await settle();
    const v = t.transport.connect(t.links[0]!.url);
    v.push({ t: 'hello', token: 'bogus.token' });
    v.push({ t: 'done' });
    await settle();
    expect(v.json()[0]).toMatchObject({ t: 'error', code: 'token_invalid' });
    expect(t.result()).toBeUndefined();
    t.engine.close();
  });
});

