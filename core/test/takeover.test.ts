import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeCdp, FakeTransport, type FakeViewer } from '../src/testing';
import { createEngine, type LinkInfo } from '../src/engine';
import { MemoryEventLog } from '../src/events';
import type { TakeoverResult } from '@unstuck/protocol';

const frame = { data: 'AQID', sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 720 } };
const realSetTimeout = globalThis.setTimeout;
/** Let crypto.subtle (thread pool) and promise chains finish without advancing fake time. */
async function settle() {
  for (let i = 0; i < 4; i++) await new Promise((r) => realSetTimeout(r, 2));
}

function setup(opts: { timeoutS?: number } = {}) {
  const transport = new FakeTransport();
  const cdp = new FakeCdp();
  const log = new MemoryEventLog();
  const links: LinkInfo[] = [];
  const engine = createEngine({ transport, log, onLink: (l) => links.push(l) });
  let result: TakeoverResult | undefined;
  const done = engine.takeover(cdp, { reason: 'Solve the CAPTCHA', site: 'shop.example', timeoutS: opts.timeoutS }).then((r) => (result = r));
  const token = () => new URL(links[0]!.url).hash.replace('#t=', '');
  const join = async (extra: object = {}) => {
    const v = transport.connect(links[0]!.sessionId);
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
    expect(v.binary()[0]![0]).toBe(0x01);
    expect(Array.from(v.binary()[0]!.slice(1, 5))).toEqual([0x05, 0x00, 0x02, 0xd0]); // 1280, 720

    v.push({ t: 'mouse', action: 'down', x: 5, y: 6, button: 'left', clickCount: 1, modifiers: 0 });
    v.push({ t: 'mouse', action: 'up', x: 5, y: 6, button: 'left', clickCount: 1, modifiers: 0 });
    await settle();
    expect(t.cdp.calls.filter((c) => c.method === 'Input.dispatchMouseEvent')).toHaveLength(2);

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
    expect(first.binary()).toHaveLength(1);
    first.push({ t: 'done' });
    await settle();
    await t.done;
    expect(t.result()!.status).toBe('resolved');
  });

  it('rejects a bad token with token_invalid', async () => {
    const t = setup();
    await settle();
    const v = t.transport.connect(t.links[0]!.sessionId);
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
    const v = transport.connect(links[0]!.sessionId);
    v.push({ t: 'hello', token: otherToken });
    await settle();
    expect(v.json()[0]).toMatchObject({ t: 'error', code: 'token_invalid' });
    await engine.close();
  });

  it('a message other than hello first closes the connection', async () => {
    const t = setup();
    await settle();
    const v = t.transport.connect(t.links[0]!.sessionId);
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
    const v = t.transport.connect(t.links[0]!.sessionId);
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
    v1.close();
    await settle();
    expect(t.cdp.methods().filter((m) => m === 'Page.stopScreencast')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    const v2 = await t.join({ resumeKey });
    expect(v2.json()[0]).toMatchObject({ t: 'ready' });
    expect(t.cdp.methods().filter((m) => m === 'Page.startScreencast')).toHaveLength(2);
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
    expect(v2.binary()).toHaveLength(1);
  });

  it('Final I2: a replacing viewer immediately gets the last frame even if the page never repaints', async () => {
    const t = setup();
    await settle();
    const v1 = await t.join();
    t.cdp.emit('Page.screencastFrame', frame);
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
    const resumeKey = v1.json()[0].resumeKey;
    v1.close();
    await settle();
    const v2 = await t.join({ resumeKey });
    expect(v2.binary().length).toBeGreaterThanOrEqual(1);
  });

  it('Final M2: finish() resolves even if Page.stopScreencast never answers', async () => {
    const t = setup();
    t.cdp.respond('Page.stopScreencast', () => new Promise(() => {}));
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
    const v = t.transport.connect(t.links[0]!.sessionId);
    await vi.advanceTimersByTimeAsync(10_000);
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
    t.cdp.respond('Page.startScreencast', () => Promise.reject(new Error('not supported')));
    await settle();
    await t.join();
    expect(t.result()).toMatchObject({ status: 'failed', detail: 'cdp_error: not supported' });
  });

  it('a slow viewer only gets the newest frame once it drains', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.bufferedAmount = 10 * 1024 * 1024;
    t.cdp.emit('Page.screencastFrame', { ...frame, data: 'AQ==' });
    t.cdp.emit('Page.screencastFrame', { ...frame, data: 'Ag==' });
    expect(v.binary()).toHaveLength(0);
    v.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(50);
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
