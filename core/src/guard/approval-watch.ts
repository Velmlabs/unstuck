import type { CdpClient } from '../cdp';
import { detectHumanCheck } from './detect';
import { APPROVAL_FAILED_RULES, RULES } from './rules';
import { SETTLE_MAX_MS, SETTLE_QUIET_MS, waitForQuiet } from './settle';

export const APPROVAL_POLL_MS = 1000;

const PROMPT = RULES.filter((r) => r.id === 'approval.prompt');
/** A failure message wins over the prompt: "Try again" pages often still show the prompt's wording. */
const FAILED_OR_PROMPT = [...APPROVAL_FAILED_RULES, ...PROMPT];

export interface WatchApprovalOptions {
  /** The page's URL when the approval prompt was found. */
  since: string;
  signal: AbortSignal;
  pollMs?: number;
  quietMs?: number;
  maxSettleMs?: number;
}

const abortError = () => new DOMException('The approval watch was aborted', 'AbortError');

/**
 * Watches a sign-in approval prompt until it goes away. `'navigated'`: the page moved on to another host or path with
 * nothing in the way. `'changed'`: the prompt gave way to a failure message or another human check. Neither is proof of
 * an approval (rescue judges the final verdict). A CDP error in one poll is retried on the next one. Rejects with an
 * `AbortError` when `signal` aborts.
 */
export function watchApproval(cdp: CdpClient, o: WatchApprovalOptions): Promise<'navigated' | 'changed'> {
  const { signal } = o;
  if (signal.aborted) return Promise.reject(abortError());
  const pollMs = o.pollMs ?? APPROVAL_POLL_MS;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });

  /** Resolves after `ms`, or as soon as the signal aborts. */
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });

  /** One look at the page: the verdict, or null to keep watching. */
  const poll = async (): Promise<'navigated' | 'changed' | null> => {
    if (await detectHumanCheck(cdp, { scope: ['approval'], rules: PROMPT })) return null;
    await waitForQuiet(cdp, o.quietMs ?? SETTLE_QUIET_MS, o.maxSettleMs ?? SETTLE_MAX_MS);
    if (signal.aborted) return null;
    const approval = await detectHumanCheck(cdp, { scope: ['approval'], rules: FAILED_OR_PROMPT });
    if (approval) return approval.ruleId === 'approval.prompt' ? null : 'changed';
    if (await detectHumanCheck(cdp, { scope: ['challenge', 'login', '2fa'], requestedUrl: o.since })) return 'changed';
    const { frameTree } = await cdp.send<{ frameTree: { frame: { url: string } } }>('Page.getFrameTree');
    return moved(o.since, frameTree.frame.url) ? 'navigated' : null;
  };

  const loop = async (): Promise<'navigated' | 'changed'> => {
    for (;;) {
      const verdict = await poll().catch(() => null); // a CDP error: look again next poll
      if (signal.aborted) return new Promise<never>(() => {}); // `aborted` has already rejected
      if (verdict) return verdict;
      await sleep(pollMs);
      if (signal.aborted) return new Promise<never>(() => {});
    }
  };

  return Promise.race([loop(), aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** True when `now` is on another host or path than `since` (query and hash don't count). */
function moved(since: string, now: string): boolean {
  try {
    const a = new URL(since);
    const b = new URL(now);
    return a.host !== b.host || a.pathname !== b.pathname;
  } catch {
    return false;
  }
}
