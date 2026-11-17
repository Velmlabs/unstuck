import { describe, it, expect } from 'vitest';
import { rescue, reasonFor } from '../../src/guard/rescue';
import { createRateLimiter } from '../../src/guard/rate-limit';
import { createMemorySessionStore } from '../../src/guard/store';
import { fakePage, page, blocked, cfCheck, runner } from './helpers';
import type { HumanCheck } from '@velmlabs/unstuck-protocol';

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
  });
});

describe('rescue', () => {
  it('a resolved takeover with the page clear is resolved, with waitedS', async () => {
    const run = runner();
    const cdp = fakePage({ facts: page() });
    expect(await rescue(cdp, cfCheck, { takeover: run, limiter: limiter(), quietMs: 10 })).toMatchObject({ status: 'resolved', waitedS: expect.any(Number), check: cfCheck, takeover: { status: 'resolved' } });
    expect(run).toHaveBeenCalledWith({ reason: "Cloudflare asks to verify you're human on shop.example", site: 'shop.example' });
  });

  it('uses the given reason', async () => {
    const run = runner();
    await rescue(fakePage({ facts: page() }), cfCheck, { takeover: run, limiter: limiter(), quietMs: 10, reason: 'Log in to the bank' });
    expect(run).toHaveBeenCalledWith({ reason: 'Log in to the bank', site: 'shop.example' });
  });

  it('the check still there after Done is still_blocked, with no second takeover', async () => {
    const run = runner();
    const o = await rescue(fakePage({ facts: blocked() }), cfCheck, { takeover: run, limiter: limiter(), quietMs: 10 });
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
});
