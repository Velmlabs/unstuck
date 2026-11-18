import { alertKindOf, type AlertKind, type CheckKind, type HumanCheck, type RescueOutcome, type TakeoverResult } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';
import { APPROVAL_FAILED_RULES, detectHumanCheck, matchRules, readFacts } from './detect';
import type { RateLimiter } from './rate-limit';
import { BROWSER_CANNOT_RENDER_HINT, type RenderCheck } from './render-check';
import { waitForQuiet } from './settle';

export const CLEAR_WAIT_MS = 6_000;
const CLEAR_POLL_MS = 250;
/** How long a person has to approve a sign-in on their phone (seconds). */
export const APPROVAL_TIMEOUT_S = 300;
/** After an approval, anything in here (even outside the guard's scope) means the agent is still not through. */
const APPROVAL_POST_SCOPE: readonly CheckKind[] = ['challenge', 'approval', 'login', '2fa'];

/** Runs one takeover for a check (the SDKs and the engine each bind their own). */
export type TakeoverRunner = (o: { reason: string; site: string; kind: AlertKind; mode?: 'approval'; timeoutS?: number }) => Promise<TakeoverResult>;

const VENDOR_NAME = { cloudflare: 'Cloudflare', recaptcha: 'reCAPTCHA', hcaptcha: 'hCaptcha' } as const;

/** What the person reads: who asks for what, on which site. */
export function reasonFor(check: HumanCheck): string {
  const site = check.site;
  if (check.kind === 'login') return `${site} asks you to log in`;
  if (check.kind === '2fa') return `${site} asks for a verification code`;
  if (check.kind === 'approval') return `${site} asks you to approve a sign-in`;
  if (check.vendor && check.vendor !== 'generic') return `${VENDOR_NAME[check.vendor]} asks to verify you're human on ${site}`;
  return `${site} asks to verify you're human`;
}

export interface RescueOptions {
  takeover: TakeoverRunner;
  limiter: RateLimiter;
  profile?: string;
  scope?: readonly CheckKind[];
  reason?: string;
  quietMs?: number;
  maxSettleMs?: number;
  /** After Done, how long a check that's still there may take to clear by itself before it's still_blocked (default 6 s). */
  clearWaitMs?: number;
  now?: () => number;
  /** A challenge on a browser that can't draw CAPTCHA widgets fails at once instead of opening a takeover no one can finish. */
  canRenderCaptcha?: RenderCheck;
  /** How long an approval takeover waits for the person (default APPROVAL_TIMEOUT_S). */
  approvalTimeoutS?: number;
}

/**
 * After an approval takeover: what the page shows now. `null` only for a readable page with nothing on it (positive
 * evidence); otherwise whether it may still clear by itself (`wait`) or is final.
 */
async function approvalVerdict(cdp: CdpClient): Promise<{ detail: string; wait: boolean } | null> {
  // detectHumanCheck gives a widget its grace but reads "can't read the page" as nothing found, so the verdict rests on
  // a readable snapshot taken after it: an unreadable page is never evidence that the approval went through.
  const seen = await detectHumanCheck(cdp, { scope: APPROVAL_POST_SCOPE });
  const facts = await readFacts(cdp);
  if (!facts) return { detail: 'approval_unreadable', wait: true };
  const failed = matchRules(facts, null, { scope: ['approval'], rules: APPROVAL_FAILED_RULES });
  if (failed) return { detail: failed.ruleId, wait: false };
  const hit = seen ?? matchRules(facts, null, { scope: APPROVAL_POST_SCOPE });
  if (!hit) return null;
  return hit.ruleId === 'approval.prompt' ? { detail: 'approval_still_showing', wait: true } : { detail: hit.ruleId, wait: false };
}

/** Brings in a person for one check. Never rejects: every way it can end is an outcome. */
export async function rescue(cdp: CdpClient, check: HumanCheck, o: RescueOptions): Promise<RescueOutcome> {
  const now = o.now ?? Date.now;
  const start = now();
  const out = (status: RescueOutcome['status'], extra: Partial<RescueOutcome> = {}): RescueOutcome => ({ status, check, waitedS: Math.round((now() - start) / 100) / 10, ...extra });
  try {
    // 'unknown' goes ahead: a doubtful probe must never block Chrome.
    if (check.kind === 'challenge' && o.canRenderCaptcha && (await o.canRenderCaptcha()) === false) {
      return { status: 'browser_cannot_render_captcha', check, waitedS: 0, detail: BROWSER_CANNOT_RENDER_HINT };
    }
    const slot = await o.limiter.tryStart();
    if (!slot.ok) {
      return out('rescue_limited', { detail: `at most ${o.limiter.maxPerHour} person-checks per hour on profile "${o.profile ?? 'default'}"; the next one is possible in ${Math.ceil(slot.retryInS / 60)} min` });
    }
    const reason = o.reason ?? reasonFor(check);
    const approval = check.kind === 'approval';
    const takeover = await o.takeover(
      approval ? { reason, site: check.site, kind: 'approval', mode: 'approval', timeoutS: o.approvalTimeoutS ?? APPROVAL_TIMEOUT_S } : { reason, site: check.site, kind: alertKindOf(check.kind) },
    );
    if (takeover.status === 'timed_out') return out('timed_out', { takeover });
    if (takeover.status === 'cancelled') return out('cancelled', { takeover, ...(takeover.detail ? { detail: takeover.detail } : {}) });
    if (takeover.status === 'failed') return out(takeover.detail === 'alert_failed' ? 'alert_failed' : 'failed', { takeover, ...(takeover.detail ? { detail: takeover.detail } : {}) });
    // Done: the page may still be redirecting (Cloudflare reloads about a second after it's solved).
    await waitForQuiet(cdp, o.quietMs, o.maxSettleMs);
    // The check may still be showing for a moment ("Verification successful", then the page's own reload), so it gets
    // a few seconds to clear, settling again after any navigation, before the answer is still_blocked.
    const until = Date.now() + (o.clearWaitMs ?? CLEAR_WAIT_MS);
    // An approval needs positive evidence: a failure page or another check ends it at once; the prompt (or a page that
    // can't be read) gets the same clear wait as a check after Done.
    while (approval) {
      const v = await approvalVerdict(cdp);
      if (!v) return out('resolved', { takeover });
      if (!v.wait || Date.now() >= until) return out('still_blocked', { takeover, detail: v.detail });
      await new Promise((r) => setTimeout(r, CLEAR_POLL_MS));
      await waitForQuiet(cdp, o.quietMs, o.maxSettleMs);
    }
    for (;;) {
      const still = await detectHumanCheck(cdp, { scope: o.scope ?? ['challenge'] });
      if (!still) return out('resolved', { takeover });
      if (Date.now() >= until) return out('still_blocked', { takeover, detail: still.ruleId });
      await new Promise((r) => setTimeout(r, CLEAR_POLL_MS));
      await waitForQuiet(cdp, o.quietMs, o.maxSettleMs);
    }
  } catch (e) {
    return out('failed', { detail: e instanceof Error ? e.message : String(e) });
  }
}
