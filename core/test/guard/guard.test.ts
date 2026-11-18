import { describe, it, expect, vi } from 'vitest';
import { createGuard } from '../../src/guard/guard';
import { createMemorySessionStore } from '../../src/guard/store';
import { fakePage, page, blocked, runner } from './helpers';
import { cookie } from '../store-conformance';

const live = (name: string, domain: string) => ({ name, value: 'v', domain, path: '/', expires: -1, httpOnly: false, secure: true });

describe('createGuard', () => {
  it('never rescues when no check is detected', async () => {
    const run = runner();
    const g = await createGuard({ cdp: fakePage({ facts: page() }), takeover: run, store: createMemorySessionStore(), widgetGraceMs: 5 });
    expect(await g.after({ requestedUrl: 'https://shop.example/' })).toBeNull();
    expect(await g.check()).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(g.lastRescue).toBeNull();
    await g.close();
  });

  it('rescues a detected check, records lastRescue and calls onRescue', async () => {
    const state = { facts: blocked() };
    const run = runner();
    run.mockImplementation(async () => {
      state.facts = page();
      return { status: 'resolved', sessionId: 's1', url: '', durationS: 1 };
    });
    const onRescue = vi.fn();
    const g = await createGuard({ cdp: fakePage(state), takeover: run, store: createMemorySessionStore(), onRescue, widgetGraceMs: 5 });
    const o = await g.after({ requestedUrl: 'https://shop.example/' });
    expect(o).toMatchObject({ status: 'resolved', check: { ruleId: 'generic.heading' } });
    expect(g.lastRescue).toBe(o);
    expect(onRescue).toHaveBeenCalledWith(o);
  });

  it('two checks at once (waitForNavigation and click together) share one rescue: one takeover, one outcome', async () => {
    const state = { facts: blocked() };
    const run = runner();
    run.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      state.facts = page();
      return { status: 'resolved', sessionId: 's1', url: '', durationS: 1 };
    });
    const g = await createGuard({ cdp: fakePage(state), takeover: run, store: createMemorySessionStore(), widgetGraceMs: 5 });
    const [a, b, c] = await Promise.all([g.after(), g.after({ mayNavigate: false }), g.check()]);
    expect(run).toHaveBeenCalledOnce();
    expect(a).toMatchObject({ status: 'resolved' });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('remember: loads stored cookies once per site before navigating, only missing ones', async () => {
    const store = createMemorySessionStore();
    await store.save('shop.example', [cookie('sid', 'stale', 'shop.example'), cookie('cf_clearance', 'x', 'shop.example')], 'UA/1');
    const cdp = fakePage({ facts: page(), cookies: [live('sid', 'shop.example')] });
    const g = await createGuard({ cdp, takeover: runner(), store, remember: true });
    await g.before({ url: 'https://www.shop.example/a' });
    await g.before({ url: 'https://shop.example/b' });
    const sets = cdp.calls.filter((c) => c.method === 'Network.setCookies');
    expect(sets).toHaveLength(1);
    expect(sets[0]!.params).toEqual({ cookies: [expect.objectContaining({ name: 'cf_clearance' })] });
  });

  it('remember: saves the rescued site and allowedSites after a resolved rescue', async () => {
    const state = { facts: blocked(), cookies: [live('cf_clearance', '.shop.example'), live('SID', '.accounts.google.com')] };
    const run = runner();
    run.mockImplementation(async () => {
      state.facts = page();
      return { status: 'resolved', sessionId: 's1', url: '', durationS: 1 };
    });
    const store = createMemorySessionStore();
    const g = await createGuard({ cdp: fakePage(state), takeover: run, store, remember: true, allowedSites: ['accounts.google.com'], widgetGraceMs: 5 });
    await g.after();
    expect(await store.load('shop.example')).toMatchObject({ userAgent: 'UA/1', cookies: [expect.objectContaining({ name: 'cf_clearance' })] });
    expect(await store.load('accounts.google.com')).toMatchObject({ cookies: [expect.objectContaining({ name: 'SID' })] });
  });

  it('remember off: saves nothing', async () => {
    const state = { facts: blocked(), cookies: [live('cf_clearance', 'shop.example')] };
    const run = runner();
    run.mockImplementation(async () => {
      state.facts = page();
      return { status: 'resolved', sessionId: 's1', url: '', durationS: 1 };
    });
    const store = createMemorySessionStore();
    const cdp = fakePage(state);
    const g = await createGuard({ cdp, takeover: run, store, widgetGraceMs: 5 });
    await g.before({ url: 'https://shop.example/' });
    await g.after();
    expect(await store.load('shop.example')).toBeNull();
    expect(cdp.methods()).not.toContain('Network.setCookies');
  });

  it('a page that navigated by itself is checked before the next action', async () => {
    const state = { facts: page() };
    const cdp = fakePage(state);
    const run = runner();
    run.mockImplementation(async () => {
      state.facts = page();
      return { status: 'resolved', sessionId: 's1', url: '', durationS: 1 };
    });
    const g = await createGuard({ cdp, takeover: run, store: createMemorySessionStore(), widgetGraceMs: 5 });
    expect(await g.before()).toBeNull();
    state.facts = blocked();
    cdp.emit('Page.frameNavigated', { frame: { id: 'MAIN', url: 'https://shop.example/' } });
    expect(await g.before()).toMatchObject({ status: 'resolved' });
    expect(await g.before()).toBeNull();
    cdp.emit('Page.frameNavigated', { frame: { id: 'CHILD', parentId: 'MAIN', url: 'https://x/' } });
    expect(await g.before()).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('askHuman counts toward the rate limit and re-checks the page', async () => {
    const state = { facts: page() };
    const run = runner();
    const g = await createGuard({ cdp: fakePage(state), takeover: run, store: createMemorySessionStore(), maxRescuesPerHour: 1, widgetGraceMs: 5 });
    expect(await g.askHuman('Type the code from the SMS')).toMatchObject({ status: 'resolved', check: { kind: 'ask', ruleId: 'ask_human', evidence: ['Type the code from the SMS'], site: 'shop.example' } });
    expect(run).toHaveBeenCalledWith({ reason: 'Type the code from the SMS', site: 'shop.example', kind: 'other' });
    expect(await g.askHuman('again')).toMatchObject({ status: 'rescue_limited' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('getSession returns cookies, the header and the user agent', async () => {
    const g = await createGuard({ cdp: fakePage({ facts: page(), cookies: [live('sid', 'shop.example')] }), takeover: runner(), store: createMemorySessionStore() });
    expect(await g.getSession()).toEqual({ site: 'shop.example', userAgent: 'UA/1', cookies: [expect.objectContaining({ name: 'sid' })], cookieHeader: 'sid=v' });
  });

  it('rememberSite saves live cookies now; forgetSite and forgetAll clear the store', async () => {
    const store = createMemorySessionStore();
    const g = await createGuard({ cdp: fakePage({ facts: page(), cookies: [live('sid', 'shop.example'), live('a', 'other.example')] }), takeover: runner(), store });
    await g.rememberSite('www.shop.example');
    await g.rememberSite('other.example');
    expect(await store.load('shop.example')).not.toBeNull();
    await g.forgetSite('shop.example');
    expect(await store.load('shop.example')).toBeNull();
    await g.forgetAll();
    expect(await store.load('other.example')).toBeNull();
  });

  it('close stops listening', async () => {
    const cdp = fakePage({ facts: page() });
    const g = await createGuard({ cdp, takeover: runner(), store: createMemorySessionStore() });
    expect(cdp.methods()).toContain('Page.enable');
    await g.close();
    expect(cdp.listenerCount('Page.frameNavigated')).toBe(0);
    expect(cdp.listenerCount('Network.responseReceived')).toBe(0);
  });
});

describe('createGuard on a browser that cannot paint CAPTCHAs', () => {
  it('passes the render check to the rescue', async () => {
    const run = runner();
    const g = await createGuard({ cdp: fakePage({ facts: blocked() }), takeover: run, store: createMemorySessionStore(), canRenderCaptcha: async () => false, widgetGraceMs: 5 });
    expect(await g.after()).toMatchObject({ status: 'browser_cannot_render_captcha' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('createGuard and approvals', () => {
  const approvalFacts = () => page({ url: 'https://accounts.example/signin', title: 'Sign in', bodyTextLength: 120, bodyTextHead: 'Check your phone to approve this sign-in.' });

  it('guard default scope detects approvals', async () => {
    const state = { facts: approvalFacts() };
    const run = runner();
    run.mockImplementation(async () => {
      state.facts = page({ url: 'https://accounts.example/home' });
      return { status: 'resolved', sessionId: 's1', url: '', durationS: 1, detail: 'approval_navigated' };
    });
    const g = await createGuard({ cdp: fakePage(state), takeover: run, store: createMemorySessionStore(), widgetGraceMs: 5 });
    expect(await g.after()).toMatchObject({ status: 'resolved', check: { kind: 'approval', ruleId: 'approval.prompt' } });
    expect(run).toHaveBeenCalledWith({ reason: 'accounts.example asks you to approve a sign-in', site: 'accounts.example', kind: 'approval', mode: 'approval', timeoutS: 300 });
  });

  it('passes approvalTimeoutS to the rescue', async () => {
    const state = { facts: approvalFacts() };
    const run = runner();
    run.mockImplementation(async () => {
      state.facts = page({ url: 'https://accounts.example/home' });
      return { status: 'resolved', sessionId: 's1', url: '', durationS: 1 };
    });
    const g = await createGuard({ cdp: fakePage(state), takeover: run, store: createMemorySessionStore(), approvalTimeoutS: 120, widgetGraceMs: 5 });
    await g.after();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ mode: 'approval', timeoutS: 120 }));
  });

  it("rescue ['challenge'] ignores approvals as before", async () => {
    const run = runner();
    const g = await createGuard({ cdp: fakePage({ facts: approvalFacts() }), takeover: run, store: createMemorySessionStore(), rescue: ['challenge'], widgetGraceMs: 5 });
    expect(await g.after()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });
});
