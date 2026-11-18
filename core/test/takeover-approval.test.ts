// Approval mode: the person sees a waiting page (one still preview, no stream) while the page is watched for the
// sign-in approval prompt to go away; "switch_control" turns it into a normal takeover.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeCdp, FakeTransport } from '../src/testing';
import { createEngine, type LinkInfo, type TakeoverControl, type TakeoverCallOptions } from '../src/engine';
import { MemoryEventLog } from '../src/events';
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import type { PageFacts } from '../src/guard/facts';
import { page } from './guard/helpers';
import { settle } from './settle';

const SINCE = 'https://login.example/approve?req=1';
const HOME = () => page({ url: 'https://app.example/home' });
const prompt = () => page({ url: SINCE, bodyTextHead: 'Sign in to Example. Check your phone and tap Yes to approve this sign-in.', bodyTextLength: 90 });
const shot = { data: 'AQID' };
const metrics = { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 } };
const frame = { data: 'AQID', sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 720 } };

function setup(call: Partial<TakeoverCallOptions> = {}, prepare: (cdp: FakeCdp, state: { facts: PageFacts }) => void = () => {}) {
  const state = { facts: prompt() };
  const cdp = new FakeCdp();
  cdp.respond('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'MAIN', url: state.facts.url } } }));
  cdp.respond('Runtime.evaluate', (p) => {
    const e = (p as { expression: string }).expression;
    if (e === 'location.href') return { result: { value: state.facts.url } };
    if (e === 'navigator.platform') return { result: { value: 'Linux x86_64' } };
    return { result: { value: state.facts } };
  });
  cdp.respond('Page.getLayoutMetrics', () => metrics);
  cdp.respond('Page.captureScreenshot', () => shot);
  prepare(cdp, state);
  const transport = new FakeTransport();
  const log = new MemoryEventLog();
  const links: LinkInfo[] = [];
  const controls: TakeoverControl[] = [];
  const engine = createEngine({ transport, log, onLink: (l, c) => (links.push(l), controls.push(c)) });
  let result: TakeoverResult | undefined;
  const done = engine
    .takeover(cdp, { reason: 'Approve the sign-in on your phone', site: 'login.example', timeoutS: 300, mode: 'approval', kind: 'approval', agentName: 'Ava', ...call })
    .then((r) => (result = r));
  const join = async () => {
    const token = new URLSearchParams(new URL(links[0]!.url).hash.slice(1)).get('t')!;
    const v = transport.connect(links[0]!.url);
    v.push({ t: 'hello', token });
    await settle();
    return v;
  };
  const finished = async () => {
    await settle();
    await vi.advanceTimersByTimeAsync(10_000); // the page settles, and the prompt gets its 6 s clear wait
    await done;
    await settle(); // the viewer opens the last frames
    return result!;
  };
  const evaluations = () => cdp.calls.filter((c) => c.method === 'Runtime.evaluate').length;
  const clicks = () => cdp.calls.filter((c) => c.method === 'Input.dispatchMouseEvent' && (c.params as { type: string }).type !== 'mouseMoved');
  return { state, cdp, transport, log, links, controls, done, join, finished, evaluations, clicks, result: () => result };
}

const click = (action: 'down' | 'up') => ({ t: 'mouse', action, x: 5, y: 6, button: 'left', clickCount: 1, modifiers: 0 });

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('approval-mode takeover', () => {
  it('cleans the agent name before the mode frame', async () => {
    const t = setup({ agentName: '\u202eTravel\u200b bot\n' });
    await settle();
    const v = await t.join();
    expect(v.json()[1]).toMatchObject({ t: 'mode', agentName: 'Travel bot' });
    const t2 = setup({ agentName: '\u200b' });
    await settle();
    expect((await t2.join()).json()[1]).not.toHaveProperty('agentName');
  });

  it('approval mode: ready, mode frame and one preview frame; no screencast; input ignored', async () => {
    const t = setup();
    await settle();
    expect(t.links[0]).toMatchObject({ kind: 'approval', mode: 'approval' });
    expect(t.links[0]!.url).toMatch(/#t=[^&]+&k=[A-Za-z0-9_-]{43}&m=a$/); // the viewer's start page says what this is
    expect(t.transport.modes.get(t.links[0]!.sessionId)).toBe('approval');
    const v = await t.join();
    const [ready, mode, ...rest] = v.json();
    expect(ready).toMatchObject({ t: 'ready', reason: 'Approve the sign-in on your phone', site: 'login.example' });
    expect(mode).toEqual({ t: 'mode', mode: 'approval', reason: 'Approve the sign-in on your phone', site: 'login.example', agentName: 'Ava' });
    expect(rest).toEqual([]); // no field map: nothing to type into
    expect(v.binary()).toHaveLength(1);
    expect(Array.from(v.binary()[0]!.slice(0, 5))).toEqual([0x01, 0x03, 0x20, 0x02, 0x58]); // type 1, 800 x 600
    expect(t.cdp.calls.filter((c) => c.method === 'Page.captureScreenshot').map((c) => c.params)).toEqual([{ format: 'jpeg', quality: 50 }]);
    // The capability probe starts and stops a 1x1 screencast once; a stream would start a second one.
    expect(t.cdp.methods().filter((m) => m === 'Page.startScreencast')).toHaveLength(1);

    v.push(click('down'));
    v.push(click('up'));
    v.push({ t: 'key', action: 'down', key: 'a', code: 'KeyA', modifiers: 0 });
    await settle();
    expect(t.clicks()).toHaveLength(0);
    expect(t.cdp.methods()).not.toContain('Input.dispatchKeyEvent');
    expect(v.closed).toBeNull();

    // A main-frame navigation refreshes the preview, debounced; subframe navigations don't.
    t.cdp.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: SINCE } });
    t.cdp.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: SINCE } });
    t.cdp.emit('Page.frameNavigated', { frame: { id: 'SUB', parentId: 'MAIN', url: 'https://ads.example/' } });
    await vi.advanceTimersByTimeAsync(499);
    expect(v.binary()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(v.binary()).toHaveLength(2);
    t.cdp.emit('Page.frameNavigated', { frame: { id: 'SUB', parentId: 'MAIN', url: 'https://ads.example/' } });
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(v.binary()).toHaveLength(2);
    t.controls[0]!.cancel('test_over');
    expect(await t.finished()).toMatchObject({ status: 'cancelled' });
  });

  it('approved with the page through ends resolved with approved_by_person, after "Checking the page…"', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    t.state.facts = HOME();
    v.push({ t: 'approved' });
    await settle();
    expect(v.json().at(-1)).toEqual({ t: 'state', status: 'active' }); // the viewer shows "Checking the page…"
    v.push({ t: 'approved' }); // a second tap while checking changes nothing
    v.push({ t: 'switch_control' }); // nor does switching while the page is judged
    const r = await t.finished();
    expect(r).toMatchObject({ status: 'resolved', detail: 'approved_by_person' });
    expect(v.json().filter((m) => m.t === 'mode')).toHaveLength(1);
    expect(v.json().at(-1)).toEqual({ t: 'state', status: 'resolved' });
    expect(t.log.events.find((e) => e.type === 'finished')?.data).toMatchObject({ status: 'resolved', detail: 'approved_by_person' });
    // The watcher stopped with the session.
    const n = t.evaluations();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.evaluations()).toBe(n);
  });

  // Review Focus 2, now judged by the session itself (the viewer and the end report see it too).
  it('approved by person with the prompt still showing ends failed approval_still_showing after the clear wait', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.push({ t: 'approved' });
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.result()).toBeUndefined(); // the prompt may still clear by itself
    expect(await t.finished()).toMatchObject({ status: 'failed', detail: 'still_blocked:approval_still_showing' });
    expect(v.json().at(-1)).toEqual({ t: 'state', status: 'failed' });
  });

  it('approved by person, the prompt clears within the clear wait: resolved', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.push({ t: 'approved' });
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    t.state.facts = HOME();
    expect(await t.finished()).toMatchObject({ status: 'resolved', detail: 'approved_by_person' });
  });

  it('a viewer that comes back while the page is judged is told so', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    const resumeKey = v.json()[0].resumeKey as string;
    v.push({ t: 'approved' });
    await settle();
    v.close();
    await settle();
    const token = new URLSearchParams(new URL(t.links[0]!.url).hash.slice(1)).get('t')!;
    const back = t.transport.connect(t.links[0]!.url);
    back.push({ t: 'hello', token, resumeKey });
    await settle();
    expect(back.json().slice(1, 3)).toEqual([expect.objectContaining({ t: 'mode', mode: 'approval' }), { t: 'state', status: 'active' }]);
    t.state.facts = HOME();
    expect(await t.finished()).toMatchObject({ status: 'resolved', detail: 'approved_by_person' });
  });

  it('an unreadable page after the approval ends failed approval_unreadable', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    t.state.facts = null as unknown as PageFacts;
    v.push({ t: 'approved' });
    expect(await t.finished()).toMatchObject({ status: 'failed', detail: 'still_blocked:approval_unreadable' });
  });

  it('a page that errors while judged ends failed approval_unreadable', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    t.cdp.respond('Page.getFrameTree', () => Promise.reject(new Error('target crashed')));
    t.cdp.respond('Runtime.evaluate', () => Promise.reject(new Error('target crashed')));
    v.push({ t: 'approved' });
    expect(await t.finished()).toMatchObject({ status: 'failed', detail: 'still_blocked:approval_unreadable' });
  });

  it('a check that throws is never taken for an approval', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    t.state.facts = {} as PageFacts; // nothing the rules can read
    v.push({ t: 'approved' });
    expect(await t.finished()).toMatchObject({ status: 'failed', detail: 'still_blocked:approval_unreadable' });
  });

  it('the agent cancelling while the page is judged ends it cancelled at once', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.push({ t: 'approved' });
    await settle();
    t.controls[0]!.cancel('cancelled_by_agent');
    expect(await t.finished()).toMatchObject({ status: 'cancelled', detail: 'cancelled_by_agent' });
  });

  it('prompt gone and page navigated ends resolved with approval_navigated', async () => {
    const t = setup();
    await settle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.result()).toBeUndefined();
    t.state.facts = page({ url: 'https://app.example/home' });
    await vi.advanceTimersByTimeAsync(15_000);
    // Nobody had to open the link: the person approved on their phone directly.
    expect(await t.finished()).toMatchObject({ status: 'resolved', detail: 'approval_navigated' });
  });

  it('prompt gone, same URL, nothing else: keeps watching until timeout', async () => {
    const t = setup({ timeoutS: 30 });
    await settle();
    t.state.facts = page({ url: SINCE, bodyTextHead: 'One moment…' });
    await vi.advanceTimersByTimeAsync(31_000);
    const r = await t.finished();
    expect(r.status).toBe('timed_out');
  });

  // Review Focus 1, now judged by the session itself.
  it('prompt replaced by a failure message ends failed with its rule, at once', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    t.state.facts = page({ url: SINCE, bodyTextHead: "We didn't hear from you. Try again.", bodyTextLength: 40 });
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(t.result()).toMatchObject({ status: 'failed', detail: 'still_blocked:approval_failed.timed_out' });
    expect(v.json().at(-1)).toEqual({ t: 'state', status: 'failed' });
    expect(v.closed).not.toBeNull();
  });

  it('prompt replaced by a 2FA page ends failed with 2fa.code', async () => {
    const t = setup();
    await settle();
    t.state.facts = page({ url: 'https://login.example/2fa', otpVisible: true, bodyTextHead: 'Enter the verification code' });
    expect(await t.finished()).toMatchObject({ status: 'failed', detail: 'still_blocked:2fa.code' });
  });

  it('switch_control starts the stream and accepts Done', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.push({ t: 'switch_control' });
    await settle();
    expect(v.json()[2]).toEqual({ t: 'mode', mode: 'control', reason: 'Approve the sign-in on your phone', site: 'login.example', agentName: 'Ava' });
    expect(t.cdp.methods().filter((m) => m === 'Page.startScreencast')).toHaveLength(2);
    t.cdp.emit('Page.screencastFrame', frame);
    await settle();
    expect(v.binary().length).toBeGreaterThanOrEqual(2);
    v.push(click('down'));
    v.push(click('up'));
    await settle();
    expect(t.clicks()).toHaveLength(2);
    v.push({ t: 'switch_control' }); // already in control: nothing happens
    await settle();
    expect(v.json().filter((m) => m.t === 'mode')).toHaveLength(2);
    // A navigation no longer refreshes a preview: the stream shows it.
    const shots = t.cdp.calls.filter((c) => c.method === 'Page.captureScreenshot').length;
    t.cdp.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: SINCE } });
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(t.cdp.calls.filter((c) => c.method === 'Page.captureScreenshot').length).toBe(shots);
    v.push({ t: 'done' });
    expect(await t.finished()).toMatchObject({ status: 'resolved' });
    expect(t.result()!.detail).toBeUndefined();
  });

  it('after switch_control the watcher keeps running and an auto-finish still ends it', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    v.push({ t: 'switch_control' });
    await settle();
    t.state.facts = HOME();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await t.finished()).toMatchObject({ status: 'resolved', detail: 'approval_navigated' });
    expect(t.cdp.methods()).toContain('Page.stopScreencast');
  });

  it('a viewer that comes back after switch_control is told it is in control', async () => {
    const t = setup();
    await settle();
    const v = await t.join();
    const resumeKey = v.json()[0].resumeKey as string;
    v.push({ t: 'switch_control' });
    await settle();
    v.close();
    await settle();
    const token = new URLSearchParams(new URL(t.links[0]!.url).hash.slice(1)).get('t')!;
    const back = t.transport.connect(t.links[0]!.url);
    back.push({ t: 'hello', token, resumeKey });
    await settle();
    expect(back.json()[1]).toMatchObject({ t: 'mode', mode: 'control' });
    back.push({ t: 'cant_solve' });
    expect(await t.finished()).toMatchObject({ status: 'cancelled', detail: 'cant_solve' });
  });

  it('answer is bad_message in an approval session; a preview that fails is skipped', async () => {
    const t = setup({}, (cdp) => cdp.respond('Page.captureScreenshot', () => Promise.reject(new Error('hidden tab'))));
    await settle();
    const v = await t.join();
    expect(v.binary()).toHaveLength(0);
    v.push({ t: 'answer', choice: 0 });
    await settle();
    expect(v.json().at(-1)).toEqual({ t: 'error', code: 'bad_message', message: expect.any(String) });
    expect(v.closed).toBeNull();
    t.state.facts = HOME();
    v.push({ t: 'approved' });
    expect(await t.finished()).toMatchObject({ status: 'resolved', detail: 'approved_by_person' });
  });

  it("the page's URL can't be read: no watcher, the person can still approve", async () => {
    const t = setup({}, (cdp, state) =>
      cdp.respond('Runtime.evaluate', (p) => {
        if ((p as { expression: string }).expression === 'location.href') throw new Error('no context');
        return { result: { value: state.facts } };
      }),
    );
    await settle();
    t.state.facts = page({ url: 'https://app.example/home' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.result()).toBeUndefined();
    expect(t.evaluations()).toBe(1);
    const v = await t.join();
    v.push({ t: 'approved' });
    expect(await t.finished()).toMatchObject({ status: 'resolved', detail: 'approved_by_person' });
  });

  it('control mode never sends a mode frame and answers approved with bad_message', async () => {
    const t = setup({ mode: undefined, kind: undefined });
    await settle();
    expect(t.links[0]!.mode).toBe('control');
    expect(t.links[0]!.kind).toBeUndefined();
    expect(t.transport.modes.get(t.links[0]!.sessionId)).toBe('control');
    const v = await t.join();
    v.push({ t: 'approved' });
    v.push({ t: 'switch_control' });
    await settle();
    expect(v.json().filter((m) => m.t === 'mode')).toEqual([]);
    expect(v.json().slice(-2)).toEqual(Array(2).fill({ t: 'error', code: 'bad_message', message: expect.any(String) }));
    t.state.facts = page({ url: 'https://app.example/home' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.result()).toBeUndefined(); // no watcher in control mode
    v.push({ t: 'done' });
    expect(await t.finished()).toMatchObject({ status: 'resolved' });
  });

  it('a preview pending when the person switches or the takeover ends is never taken', async () => {
    const t = setup();
    await settle();
    // The stream takes its own first screenshot (quality 70); previews are quality 50.
    const shots = () => t.cdp.calls.filter((c) => c.method === 'Page.captureScreenshot' && (c.params as { quality: number }).quality === 50).length;
    t.cdp.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: SINCE } });
    await vi.advanceTimersByTimeAsync(600); // nobody on the link: nothing to show
    expect(shots()).toBe(0);
    const v = await t.join();
    t.cdp.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: SINCE } });
    v.push({ t: 'switch_control' });
    await settle();
    await vi.advanceTimersByTimeAsync(600);
    expect(shots()).toBe(1);
    v.push({ t: 'cant_solve' });
    await settle();
    expect(await t.finished()).toMatchObject({ status: 'cancelled' });

    const u = setup();
    await settle();
    const w = await u.join();
    u.cdp.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: SINCE } });
    u.controls[0]!.cancel('cancelled_by_agent');
    await settle();
    await vi.advanceTimersByTimeAsync(600);
    expect(u.cdp.calls.filter((c) => c.method === 'Page.captureScreenshot')).toHaveLength(1);
    expect(await u.finished()).toMatchObject({ detail: 'cancelled_by_agent' });
    expect(w.closed).not.toBeNull();
  });

  it('a location.href that is not a string starts no watcher', async () => {
    const t = setup({}, (cdp, state) =>
      cdp.respond('Runtime.evaluate', (p) => ((p as { expression: string }).expression === 'location.href' ? { result: {} } : { result: { value: state.facts } })),
    );
    await settle();
    t.state.facts = page({ url: 'https://app.example/home' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.result()).toBeUndefined();
    t.controls[0]!.cancel('test_over');
    expect(await t.finished()).toMatchObject({ status: 'cancelled' });
  });

  it('ended settles with the result', async () => {
    const t = setup();
    await settle();
    const ended = t.controls[0]!.ended;
    const v = await t.join();
    v.push({ t: 'approved' });
    const r = await t.finished();
    expect(await ended).toBe(r);
  });
});
