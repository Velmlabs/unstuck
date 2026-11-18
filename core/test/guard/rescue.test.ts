import { describe, it, expect, vi } from 'vitest';
import { rescue, reasonFor } from '../../src/guard/rescue';
import { createRateLimiter } from '../../src/guard/rate-limit';
import { createMemorySessionStore } from '../../src/guard/store';
import { fakePage, page, blocked, cfCheck, runner } from './helpers';
import type { HumanCheck } from '@velmlabs/unstuck-protocol';
import type { PageFacts } from '../../src/guard/facts';

const limiter = () => createRateLimiter(createMemorySessionStore());

describe('reasonFor', () => {
  it('words each kind of check for the person', () => {
    const c = (o: Partial<HumanCheck>): HumanCheck => ({ ...cfCheck, ...o });
    expect(reasonFor(cfCheck)).toBe("Cloudflare asks to verify you're human on shop.example");
    expect(reasonFor(c({ vendor: 'recaptcha' }))).toBe("reCAPTCHA asks to verify you're human on shop.example");
    expect(reasonFor(c({ vendor: 'hcaptcha' }))).toBe("hCaptcha asks to verify you're human on shop.example");
    expect(reasonFor(c({ vendor: 'generic' }))).toBe("shop.example asks to verify you're human");
    expect(reasonFor(c({ kind: 'login', vendor: undefined }))).toBe('shop.example asks you to log in');
    expect(reasonFor(c({ kind: '2fa', vendor: undefined }))).toBe('shop.example asks for a verification code');
    expect(reasonFor(c({ kind: 'approval', vendor: undefined, site: 'accounts.example' }))).toBe('accounts.example asks you to approve a sign-in');
  });
});

describe('rescue', () => {
  it('a resolved takeover with the page clear is resolved, with waitedS', async () => {
    const run = runner();
    const cdp = fakePage({ facts: page() });
    expect(await rescue(cdp, cfCheck, { takeover: run, limiter: limiter(), quietMs: 10 })).toMatchObject({ status: 'resolved', waitedS: expect.any(Number), check: cfCheck, takeover: { status: 'resolved' } });
    expect(run).toHaveBeenCalledWith({ reason: "Cloudflare asks to verify you're human on shop.example", site: 'shop.example', kind: 'challenge' });
  });

  it('uses the given reason', async () => {
    const run = runner();
    await rescue(fakePage({ facts: page() }), cfCheck, { takeover: run, limiter: limiter(), quietMs: 10, reason: 'Log in to the bank' });
    expect(run).toHaveBeenCalledWith({ reason: 'Log in to the bank', site: 'shop.example', kind: 'challenge' });
  });

  it('the check still there after Done is still_blocked, with no second takeover', async () => {
    const run = runner();
    const o = await rescue(fakePage({ facts: blocked() }), cfCheck, { takeover: run, limiter: limiter(), quietMs: 10, clearWaitMs: 50 });
    expect(o).toMatchObject({ status: 'still_blocked', detail: 'generic.heading' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['timed_out', undefined, 'timed_out', undefined],
    ['cancelled', 'too hard', 'cancelled', 'too hard'],
    ['failed', 'alert_failed', 'alert_failed', 'alert_failed'],
    ['failed', 'page_closed', 'failed', 'page_closed'],
  ] as const)('takeover %s/%s → %s', async (status, detail, want, wantDetail) => {
    const o = await rescue(fakePage({ facts: page() }), cfCheck, { takeover: runner(status, detail), limiter: limiter(), quietMs: 10 });
    expect(o.status).toBe(want);
    expect(o.detail).toBe(wantDetail);
  });

  it('a takeover that throws is failed, never a rejection', async () => {
    const o = await rescue(fakePage({ facts: page() }), cfCheck, {
      takeover: async () => {
        throw new Error('relay refused');
      },
      limiter: limiter(),
    });
    expect(o).toMatchObject({ status: 'failed', detail: 'relay refused' });
  });

  it('over the limit returns rescue_limited without a takeover', async () => {
    const run = runner();
    const l = createRateLimiter(createMemorySessionStore(), { maxPerHour: 1 });
    const cdp = fakePage({ facts: page() });
    expect((await rescue(cdp, cfCheck, { takeover: run, limiter: l, profile: 'default', quietMs: 10 })).status).toBe('resolved');
    const o2 = await rescue(cdp, cfCheck, { takeover: run, limiter: l, profile: 'default', quietMs: 10 });
    expect(o2).toMatchObject({ status: 'rescue_limited', detail: 'at most 1 person-checks per hour on profile "default"; the next one is possible in 60 min' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  // Review Focus 3
  it('Done while the page is still redirecting waits for it to settle: resolved, not still_blocked', async () => {
    const state = { facts: blocked() };
    const cdp = fakePage(state);
    const run = runner();
    run.mockImplementation(async () => {
      setTimeout(() => cdp.emit('Page.frameStartedLoading', { frameId: 'MAIN' }), 300);
      setTimeout(() => {
        state.facts = page();
        cdp.emit('Page.loadEventFired', {});
      }, 900);
      return { status: 'resolved', sessionId: 's1', url: 'https://shop.example/', durationS: 3 };
    });
    expect((await rescue(cdp, cfCheck, { takeover: run, limiter: limiter(), quietMs: 500 })).status).toBe('resolved');
  });

  it("Review Focus 3: Done tapped well before the page's own reload (more than the quiet time) is still resolved", async () => {
    const state = { facts: blocked() };
    const cdp = fakePage(state);
    const run = runner();
    run.mockImplementation(async () => {
      // Cloudflare reloads about a second after the solve, which can be 1.5 s after the person taps Done.
      setTimeout(() => cdp.emit('Page.frameStartedLoading', { frameId: 'MAIN' }), 1500);
      setTimeout(() => {
        state.facts = page();
        cdp.emit('Page.loadEventFired', {});
      }, 1900);
      return { status: 'resolved', sessionId: 's1', url: 'https://shop.example/', durationS: 3 };
    });
    expect((await rescue(cdp, cfCheck, { takeover: run, limiter: limiter(), quietMs: 500 })).status).toBe('resolved');
  });

  it('a check that never clears is still_blocked once the clear wait is over', async () => {
    const t0 = Date.now();
    const o = await rescue(fakePage({ facts: blocked() }), cfCheck, { takeover: runner(), limiter: limiter(), quietMs: 10, clearWaitMs: 300 });
    expect(o.status).toBe('still_blocked');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
  });
});

describe('rescue on a browser that cannot paint cross-origin iframes', () => {
  it('a challenge fails clearly, without a takeover or a slot', async () => {
    const run = runner();
    const l = createRateLimiter(createMemorySessionStore(), { maxPerHour: 1 });
    const o = await rescue(fakePage({ facts: page() }), cfCheck, { takeover: run, limiter: l, canRenderCaptcha: async () => false });
    expect(o).toMatchObject({ status: 'browser_cannot_render_captcha', detail: "this browser can't show CAPTCHAs; use Chrome for this site", waitedS: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(await l.tryStart()).toEqual({ ok: true });
  });

  it('login and 2FA are rescued on such a browser, without probing', async () => {
    const run = runner();
    const probe = async () => false as const;
    const spy = vi.fn(probe);
    expect((await rescue(fakePage({ facts: page() }), { ...cfCheck, kind: 'login', vendor: undefined }, { takeover: run, limiter: limiter(), canRenderCaptcha: spy, quietMs: 10 })).status).toBe('resolved');
    expect(run).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("'unknown' goes ahead with the takeover", async () => {
    const run = runner();
    expect((await rescue(fakePage({ facts: page() }), cfCheck, { takeover: run, limiter: limiter(), canRenderCaptcha: async () => 'unknown', quietMs: 10 })).status).toBe('resolved');
    expect(run).toHaveBeenCalledTimes(1);
  });
});

const approvalCheck: HumanCheck = { kind: 'approval', ruleId: 'approval.prompt', evidence: ['text "check your phone"'], url: 'https://accounts.example/signin', site: 'accounts.example' };
const approvalPage = (o: Partial<PageFacts> = {}) => page({ url: 'https://accounts.example/signin', title: 'Sign in', bodyTextLength: 120, bodyTextHead: 'Check your phone to approve this sign-in.', ...o });

describe('rescue for approvals', () => {
  it('an approval check runs an approval-mode takeover with 300 s and kind approval', async () => {
    const takeover = runner('resolved', 'approval_navigated');
    await rescue(fakePage({ facts: page({ url: 'https://accounts.example/home' }) }), approvalCheck, { takeover, limiter: limiter(), quietMs: 10 });
    expect(takeover).toHaveBeenCalledWith(expect.objectContaining({ mode: 'approval', kind: 'approval', timeoutS: 300, reason: 'accounts.example asks you to approve a sign-in' }));
  });

  it('uses the given approval timeout', async () => {
    const takeover = runner('resolved', 'approval_navigated');
    await rescue(fakePage({ facts: page() }), approvalCheck, { takeover, limiter: limiter(), quietMs: 10, approvalTimeoutS: 90 });
    expect(takeover).toHaveBeenCalledWith({ reason: 'accounts.example asks you to approve a sign-in', site: 'accounts.example', kind: 'approval', mode: 'approval', timeoutS: 90 });
  });

  // Review Focus 1
  it('approval prompt replaced by a timeout message is still_blocked', async () => {
    const t0 = Date.now();
    const cdp = fakePage({ facts: approvalPage({ bodyTextHead: "We didn't hear from you. Try again." }) });
    const o = await rescue(cdp, approvalCheck, { takeover: runner('resolved', 'approval_changed'), limiter: limiter(), quietMs: 10, clearWaitMs: 2000 });
    expect(o).toMatchObject({ status: 'still_blocked', detail: 'approval_failed.timed_out' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a denied push and a retry page are still_blocked, even with the prompt wording still there', async () => {
    const denied = await rescue(fakePage({ facts: approvalPage({ bodyTextHead: 'Sign-in denied.' }) }), approvalCheck, { takeover: runner(), limiter: limiter(), quietMs: 10 });
    expect(denied).toMatchObject({ status: 'still_blocked', detail: 'approval_failed.denied' });
    const retry = await rescue(fakePage({ facts: approvalPage({ bodyTextHead: 'Check your phone to approve this sign-in. Try again' }) }), approvalCheck, { takeover: runner(), limiter: limiter(), quietMs: 10 });
    expect(retry).toMatchObject({ status: 'still_blocked', detail: 'approval_failed.retry' });
  });

  // Review Focus 2
  it('approved by person but prompt still showing', async () => {
    const t0 = Date.now();
    const o = await rescue(fakePage({ facts: approvalPage() }), approvalCheck, { takeover: runner('resolved', 'approved_by_person'), limiter: limiter(), quietMs: 10, clearWaitMs: 300 });
    expect(o).toMatchObject({ status: 'still_blocked', detail: 'approval_still_showing' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
  });

  it('approved by person, the prompt clears within the clear wait: resolved', async () => {
    const state = { facts: approvalPage() };
    const run = runner('resolved', 'approved_by_person');
    run.mockImplementation(async () => {
      setTimeout(() => (state.facts = page({ url: 'https://accounts.example/home' })), 200);
      return { status: 'resolved', sessionId: 's1', url: '', durationS: 3, detail: 'approved_by_person' };
    });
    expect(await rescue(fakePage(state), approvalCheck, { takeover: run, limiter: limiter(), quietMs: 10, clearWaitMs: 2000 })).toMatchObject({ status: 'resolved' });
  });

  it.each(['approval_still_showing', 'approval_unreadable', 'approval_failed.denied', '2fa.code'])(
    'an approval session that judged the page not through (still_blocked:%s) is still_blocked with that detail, without looking again',
    async (detail) => {
      const cdp = fakePage({ facts: page({ url: 'https://accounts.example/home' }) });
      const o = await rescue(cdp, approvalCheck, { takeover: runner('failed', `still_blocked:${detail}`), limiter: limiter(), quietMs: 10 });
      expect(o).toMatchObject({ status: 'still_blocked', detail, takeover: { status: 'failed', detail: `still_blocked:${detail}` } });
      expect(cdp.calls).toEqual([]);
    },
  );

  it('approval resolved when the page navigated and nothing matches', async () => {
    const o = await rescue(fakePage({ facts: page({ url: 'https://accounts.example/home', bodyTextHead: 'Welcome back' }) }), approvalCheck, { takeover: runner('resolved', 'approval_navigated'), limiter: limiter(), quietMs: 10 });
    expect(o).toMatchObject({ status: 'resolved', takeover: { status: 'resolved', detail: 'approval_navigated' } });
  });

  it('approval followed by a 2FA page is still_blocked with 2fa.code even though scope lacks 2fa', async () => {
    const t0 = Date.now();
    const facts = page({ url: 'https://accounts.example/2fa', otpVisible: true, bodyTextHead: 'Enter the verification code' });
    const o = await rescue(fakePage({ facts }), approvalCheck, { takeover: runner('resolved', 'approval_changed'), limiter: limiter(), quietMs: 10, scope: ['challenge', 'approval'], clearWaitMs: 2000 });
    expect(o).toMatchObject({ status: 'still_blocked', detail: '2fa.code' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('approval followed by a challenge is still_blocked with its rule', async () => {
    const o = await rescue(fakePage({ facts: blocked() }), approvalCheck, { takeover: runner('resolved', 'approval_changed'), limiter: limiter(), quietMs: 10, clearWaitMs: 2000 });
    expect(o).toMatchObject({ status: 'still_blocked', detail: 'generic.heading' });
  });

  it('an unreadable page is never resolved: still_blocked approval_unreadable at the deadline', async () => {
    const t0 = Date.now();
    const o = await rescue(fakePage({ facts: null as unknown as PageFacts }), approvalCheck, { takeover: runner('resolved', 'approved_by_person'), limiter: limiter(), quietMs: 10, clearWaitMs: 300 });
    expect(o).toMatchObject({ status: 'still_blocked', detail: 'approval_unreadable' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
  });

  it('an unreadable page that becomes readable and clear is resolved', async () => {
    const state = { facts: null as unknown as PageFacts };
    const run = runner('resolved', 'approval_navigated');
    run.mockImplementation(async () => {
      setTimeout(() => (state.facts = page({ url: 'https://accounts.example/home' })), 200);
      return { status: 'resolved', sessionId: 's1', url: '', durationS: 3, detail: 'approval_navigated' };
    });
    expect(await rescue(fakePage(state), approvalCheck, { takeover: run, limiter: limiter(), quietMs: 10, clearWaitMs: 2000 })).toMatchObject({ status: 'resolved' });
  });

  it('approvals count toward the hourly limit', async () => {
    const run = runner('resolved', 'approval_navigated');
    const l = createRateLimiter(createMemorySessionStore(), { maxPerHour: 1 });
    const cdp = fakePage({ facts: page() });
    expect((await rescue(cdp, approvalCheck, { takeover: run, limiter: l, quietMs: 10 })).status).toBe('resolved');
    expect((await rescue(cdp, approvalCheck, { takeover: run, limiter: l, quietMs: 10 })).status).toBe('rescue_limited');
    expect((await rescue(cdp, cfCheck, { takeover: run, limiter: l, quietMs: 10 })).status).toBe('rescue_limited');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('login and 2fa checks get kind login; askHuman gets kind other', async () => {
    const run = runner();
    const cdp = fakePage({ facts: page() });
    await rescue(cdp, { ...cfCheck, kind: 'login', vendor: undefined, ruleId: 'login.redirect' }, { takeover: run, limiter: limiter(), quietMs: 10 });
    await rescue(cdp, { ...cfCheck, kind: '2fa', vendor: undefined, ruleId: '2fa.code' }, { takeover: run, limiter: limiter(), quietMs: 10 });
    await rescue(cdp, { kind: 'ask', ruleId: 'ask_human', evidence: ['Type the code'], url: 'https://shop.example/', site: 'shop.example' }, { takeover: run, limiter: limiter(), quietMs: 10, reason: 'Type the code' });
    expect(run.mock.calls.map((c) => c[0])).toEqual([
      { reason: 'shop.example asks you to log in', site: 'shop.example', kind: 'login' },
      { reason: 'shop.example asks for a verification code', site: 'shop.example', kind: 'login' },
      { reason: 'Type the code', site: 'shop.example', kind: 'other' },
    ]);
  });
});
