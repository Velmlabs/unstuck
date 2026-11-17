import type { CheckKind, HumanCheck, RescueOutcome, TakeoverResult } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';
import { detectHumanCheck } from './detect';
import type { RateLimiter } from './rate-limit';
import { waitForQuiet } from './settle';

/** Runs one takeover for a check (the SDKs and the engine each bind their own). */
export type TakeoverRunner = (o: { reason: string; site: string }) => Promise<TakeoverResult>;

const VENDOR_NAME = { cloudflare: 'Cloudflare', recaptcha: 'reCAPTCHA', hcaptcha: 'hCaptcha' } as const;

/** What the person reads: who asks for what, on which site. */
export function reasonFor(check: HumanCheck): string {
  const site = check.site;
  if (check.kind === 'login') return `${site} asks you to log in`;
  if (check.kind === '2fa') return `${site} asks for a verification code`;
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
  now?: () => number;
}

/** Brings in a person for one check. Never rejects: every way it can end is an outcome. */
export async function rescue(cdp: CdpClient, check: HumanCheck, o: RescueOptions): Promise<RescueOutcome> {
  const now = o.now ?? Date.now;
  const start = now();
  const out = (status: RescueOutcome['status'], extra: Partial<RescueOutcome> = {}): RescueOutcome => ({ status, check, waitedS: Math.round((now() - start) / 100) / 10, ...extra });
  try {
    const slot = await o.limiter.tryStart();
    if (!slot.ok) {
      return out('rescue_limited', { detail: `at most ${o.limiter.maxPerHour} person-checks per hour on profile "${o.profile ?? 'default'}"; the next one is possible in ${Math.ceil(slot.retryInS / 60)} min` });
    }
    const takeover = await o.takeover({ reason: o.reason ?? reasonFor(check), site: check.site });
    if (takeover.status === 'timed_out') return out('timed_out', { takeover });
    if (takeover.status === 'cancelled') return out('cancelled', { takeover, ...(takeover.detail ? { detail: takeover.detail } : {}) });
    if (takeover.status === 'failed') return out(takeover.detail === 'alert_failed' ? 'alert_failed' : 'failed', { takeover, ...(takeover.detail ? { detail: takeover.detail } : {}) });
    // Done: the page may still be redirecting (Cloudflare reloads about a second after it's solved).
    await waitForQuiet(cdp, o.quietMs, o.maxSettleMs);
    const still = await detectHumanCheck(cdp, { scope: o.scope ?? ['challenge'] });
    return still ? out('still_blocked', { takeover, detail: still.ruleId }) : out('resolved', { takeover });
  } catch (e) {
    return out('failed', { detail: e instanceof Error ? e.message : String(e) });
  }
}
