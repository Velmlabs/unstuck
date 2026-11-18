import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watchApproval } from '../../src/guard/approval-watch';
import { FakeCdp } from '../../src/testing/fake-cdp';
import type { PageFacts } from '../../src/guard/facts';
import { page } from './helpers';

const prompt = (url = 'https://login.example/approve?x=1') =>
  page({ url, bodyTextHead: 'Sign in to Example. Check your phone and tap Yes to approve this sign-in.', bodyTextLength: 90 });

/** A page whose facts (and main-frame URL) the test changes between polls. */
function approvalPage(state: { facts: PageFacts }) {
  const cdp = new FakeCdp();
  cdp.respond('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'MAIN', url: state.facts.url } } }));
  cdp.respond('Runtime.evaluate', () => ({ result: { value: state.facts } }));
  return cdp;
}

const SINCE = 'https://login.example/approve?x=1';
const opts = (signal: AbortSignal) => ({ since: SINCE, signal, pollMs: 1000, quietMs: 100, maxSettleMs: 500 });

/** Tracks whether the watch has settled, without an unhandled rejection. */
function track(p: Promise<string>) {
  const s: { value?: string; error?: unknown } = {};
  p.then(
    (v) => (s.value = v),
    (e) => (s.error = e),
  );
  return s;
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('watchApproval', () => {
  it('keeps waiting while the prompt shows, then reports navigated once it is gone and the page moved on', async () => {
    const state = { facts: prompt() };
    const s = track(watchApproval(approvalPage(state), opts(new AbortController().signal)));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s).toEqual({});
    state.facts = page({ url: 'https://login.example/home' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s).toEqual({ value: 'navigated' });
  });

  it('a different host is a navigation; only a different query or hash is not', async () => {
    const state = { facts: page({ url: 'https://login.example/approve?x=2#done' }) };
    const s = track(watchApproval(approvalPage(state), opts(new AbortController().signal)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s).toEqual({});
    state.facts = page({ url: 'https://app.example/approve' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s).toEqual({ value: 'navigated' });
  });

  it('reports changed when the prompt is replaced by a failure message on the same URL', async () => {
    const state = { facts: prompt() };
    const s = track(watchApproval(approvalPage(state), opts(new AbortController().signal)));
    await vi.advanceTimersByTimeAsync(2_000);
    state.facts = page({ url: SINCE, bodyTextHead: "We didn't hear from you. Request timed out.", bodyTextLength: 60 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s).toEqual({ value: 'changed' });
  });

  it('reports changed when a challenge, login or code page takes its place, even on a new URL', async () => {
    const state = { facts: prompt() };
    const s = track(watchApproval(approvalPage(state), opts(new AbortController().signal)));
    await vi.advanceTimersByTimeAsync(1_500);
    state.facts = page({ url: 'https://login.example/verify', headings: ['Verify you are human'], bodyTextLength: 100 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s).toEqual({ value: 'changed' });
  });

  it('prompt gone, same URL and nothing else: keeps watching', async () => {
    const state = { facts: prompt() };
    const s = track(watchApproval(approvalPage(state), opts(new AbortController().signal)));
    state.facts = page({ url: SINCE, bodyTextHead: 'Loading…' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s).toEqual({});
  });

  it('a prompt that is back once the page settles keeps it watching', async () => {
    const state = { facts: prompt() };
    const cdp = approvalPage(state);
    let reads = 0;
    // Gone for exactly one read (a re-render), then back, on a new URL.
    cdp.respond('Runtime.evaluate', () => ({ result: { value: ++reads === 2 ? page({ url: 'https://login.example/other' }) : prompt('https://login.example/other') } }));
    const s = track(watchApproval(cdp, opts(new AbortController().signal)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBeGreaterThan(3);
    expect(s).toEqual({});
  });

  it('waits for the page to go quiet before it judges', async () => {
    const state = { facts: page({ url: 'https://login.example/home' }) };
    const cdp = approvalPage(state);
    const s = track(watchApproval(cdp, { since: SINCE, signal: new AbortController().signal, pollMs: 1000, quietMs: 300, maxSettleMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(200);
    cdp.emit('Page.frameStartedLoading', { frameId: 'MAIN' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s).toEqual({}); // a load in flight is never quiet
    cdp.emit('Page.loadEventFired', {});
    await vi.advanceTimersByTimeAsync(400);
    expect(s).toEqual({ value: 'navigated' });
  });

  it('facts that cannot be read after the prompt went never count as navigated; a later readable poll decides', async () => {
    const state = { facts: prompt() };
    const cdp = approvalPage(state);
    let unreadable = false;
    cdp.respond('Runtime.evaluate', () => {
      if (unreadable) throw new Error('Execution context was destroyed');
      return { result: { value: state.facts } };
    });
    const s = track(watchApproval(cdp, opts(new AbortController().signal)));
    await vi.advanceTimersByTimeAsync(2_000);
    unreadable = true;
    state.facts = page({ url: 'https://login.example/home' }); // the frame tree already says the page moved
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s).toEqual({});
    // Readable again: it is a failure page after all.
    state.facts = page({ url: 'https://login.example/home', bodyTextHead: "We didn't hear from you.", bodyTextLength: 30 });
    unreadable = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s).toEqual({ value: 'changed' });
  });

  it('a page that returns no facts keeps it watching too', async () => {
    const state = { facts: page({ url: 'https://login.example/home' }) };
    const cdp = approvalPage(state);
    cdp.respond('Runtime.evaluate', () => ({ exceptionDetails: { text: 'boom' } }));
    const s = track(watchApproval(cdp, opts(new AbortController().signal)));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s).toEqual({});
  });

  it('an error thrown in a poll (a malformed facts result) is retried on the next poll', async () => {
    const state = { facts: { ...page({ url: 'https://login.example/home' }), headings: undefined } as unknown as PageFacts };
    const s = track(watchApproval(approvalPage(state), opts(new AbortController().signal)));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(s).toEqual({});
    state.facts = page({ url: 'https://login.example/home' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s).toEqual({ value: 'navigated' });
  });

  it('an unreadable since URL never counts as a navigation', async () => {
    const state = { facts: page({ url: 'https://login.example/home' }) };
    const s = track(watchApproval(approvalPage(state), { ...opts(new AbortController().signal), since: 'not a url' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(s).toEqual({});
  });

  it('rejects with an AbortError when the signal aborts, and stops polling', async () => {
    const state = { facts: prompt() };
    const cdp = approvalPage(state);
    const ac = new AbortController();
    const s = track(watchApproval(cdp, opts(ac.signal)));
    await vi.advanceTimersByTimeAsync(2_500);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect((s.error as Error).name).toBe('AbortError');
    const calls = cdp.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cdp.calls.length).toBe(calls);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(watchApproval(approvalPage({ facts: prompt() }), opts(ac.signal))).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborting while the page settles rejects too', async () => {
    const cdp = approvalPage({ facts: page({ url: 'https://login.example/home' }) });
    const ac = new AbortController();
    const s = track(watchApproval(cdp, { since: SINCE, signal: ac.signal, quietMs: 1_000, maxSettleMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(500);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect((s.error as Error).name).toBe('AbortError');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.value).toBeUndefined();
  });
});
