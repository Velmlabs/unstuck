import type { CheckKind } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';
import { APPROVAL_FAILED_RULES, detectHumanCheck, matchRules, readFacts } from './detect';
import { waitForQuiet } from './settle';

/** After Done or an approval, how long a check that's still there may take to clear by itself (ms). */
export const CLEAR_WAIT_MS = 6_000;
export const CLEAR_POLL_MS = 250;
/** After an approval, anything in here (even outside the guard's scope) means the agent is still not through. */
const APPROVAL_POST_SCOPE: readonly CheckKind[] = ['challenge', 'approval', 'login', '2fa'];

/**
 * An approval session that ended without proof the sign-in went through finishes `failed` with this prefix and the
 * verdict's detail (`still_blocked:approval_still_showing`, `still_blocked:approval_unreadable`,
 * `still_blocked:<ruleId>`); rescue turns it back into `still_blocked` with the detail after the prefix.
 */
export const STILL_BLOCKED_PREFIX = 'still_blocked:';

/**
 * What the page shows now, after an approval. `null` only for a readable page with nothing on it (positive evidence);
 * otherwise whether it may still clear by itself (`wait`) or is final.
 */
export async function approvalVerdict(cdp: CdpClient): Promise<{ detail: string; wait: boolean } | null> {
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

export interface CheckApprovalOptions {
  quietMs?: number;
  maxSettleMs?: number;
  /** How long the prompt (or a page that can't be read) may take to clear before the verdict is final (default 6 s). */
  clearWaitMs?: number;
  /** Stops waiting for the prompt to clear (the verdict seen last is final). */
  signal?: AbortSignal;
}

/**
 * Judges an approval: settles the page, then needs positive evidence. A failure page or another check ends it at once;
 * the prompt (or a page that can't be read) gets the clear wait. Resolves to `null` when the sign-in went through,
 * otherwise to the verdict's detail (`approval_still_showing`, `approval_unreadable` or a rule id).
 */
export async function checkApproval(cdp: CdpClient, o: CheckApprovalOptions = {}): Promise<string | null> {
  await waitForQuiet(cdp, o.quietMs, o.maxSettleMs);
  const until = Date.now() + (o.clearWaitMs ?? CLEAR_WAIT_MS);
  for (;;) {
    const v = await approvalVerdict(cdp);
    if (!v) return null;
    if (!v.wait || Date.now() >= until || o.signal?.aborted) return v.detail;
    await new Promise((r) => setTimeout(r, CLEAR_POLL_MS));
    await waitForQuiet(cdp, o.quietMs, o.maxSettleMs);
  }
}
