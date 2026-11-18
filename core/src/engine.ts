import type { AlertKind, TakeoverResult } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from './cdp';
import type { EventLog } from './events';
import type { Transport } from './transport';
import { importSecret, newSecret } from './session/tokens';
import { CAPTURE_TIMEOUT_MS, within } from './stream/within';
import { runTakeover, type LinkInfo, type PopupSource, type RunningTakeover, type TakeoverControl } from './session/takeover';

export type { LinkInfo, PopupSource, TakeoverControl } from './session/takeover';
/** Gets each takeover's link; `takeover.fail(detail)` ends that takeover as failed (e.g. when the link can't be delivered). */
export type LinkHandler = (info: LinkInfo, takeover: TakeoverControl) => void;

export interface EngineOptions {
  transport: Transport;
  log?: EventLog;
  secret?: Uint8Array;
  now?: () => number;
  defaultTimeoutS?: number;
  onLink?: LinkHandler;
  /** Default for `requireCode` on every takeover. */
  requireCode?: boolean;
}

export interface TakeoverCallOptions {
  reason: string;
  /** Follow popups the page opens (spec §10). */
  popups?: PopupSource;
  timeoutS?: number;
  site?: string;
  onLink?: LinkHandler;
  /** Ask the human for a 6-digit code delivered with the link. */
  requireCode?: boolean;
  /** Sites besides the page's own the human may navigate to (e.g. an SSO or 3-D Secure provider). */
  allowedSites?: string[];
  /**
   * `approval`: the page shows a sign-in approval prompt; the person gets a waiting page, and the takeover ends by
   * itself once the prompt goes away (they can still switch to control). Default `control`.
   */
  mode?: 'control' | 'approval';
  /** What the alert is about (passed on in the link info). */
  kind?: AlertKind;
  /** The agent's name, shown to the person in approval mode. */
  agentName?: string;
}

export interface Engine {
  /** Never rejects: every failure becomes a TakeoverResult. */
  takeover(cdp: CdpClient, opts: TakeoverCallOptions): Promise<TakeoverResult>;
  /** Cancels in-flight takeovers (detail `engine_closed`) and closes the transport; later takeovers end the same way. */
  close(): Promise<void>;
}

export const DEFAULT_TIMEOUT_S = 600;

export function createEngine(opts: EngineOptions): Engine {
  const key = importSecret(opts.secret ?? newSecret());
  const now = opts.now ?? (() => Date.now());
  const running = new Set<RunningTakeover>();
  let closed = false;

  return {
    async takeover(cdp, call) {
      // Subscribe before any await so a page that closes during setup is not missed.
      let closedBefore: string | undefined;
      const off = cdp.onClose((reason) => (closedBefore ??= reason));
      const k = await key;
      // Where the approval prompt is: the watcher reports `navigated` only once the page has left this URL.
      const approvalSince = call.mode === 'approval' && closedBefore === undefined ? await pageUrl(cdp) : undefined;
      off();
      // close() ran while this takeover was starting (or before it): it never publishes.
      if (closed) return { status: 'cancelled', sessionId: '', url: '', durationS: 0, detail: 'engine_closed' };
      const session = runTakeover({ transport: opts.transport, key: k, log: opts.log, now }, cdp, {
        closedBefore,
        reason: call.reason,
        timeoutS: call.timeoutS ?? opts.defaultTimeoutS ?? DEFAULT_TIMEOUT_S,
        site: call.site,
        onLink: call.onLink ?? opts.onLink,
        popups: call.popups,
        requireCode: call.requireCode ?? opts.requireCode,
        ...(call.allowedSites ? { allowedSites: call.allowedSites } : {}),
        ...(call.mode ? { mode: call.mode } : {}),
        ...(call.kind ? { kind: call.kind } : {}),
        ...(call.agentName ? { agentName: call.agentName } : {}),
        ...(approvalSince !== undefined ? { approvalSince } : {}),
      });
      running.add(session);
      try {
        return await session.result;
      } finally {
        running.delete(session);
      }
    },
    async close() {
      closed = true;
      const results = [...running].map((s) => {
        s.cancel('engine_closed');
        return s.result;
      });
      await Promise.all(results);
      await opts.transport.close();
    },
  };
}

/** The page's URL, or undefined when it can't be read. */
async function pageUrl(cdp: CdpClient): Promise<string | undefined> {
  try {
    const r = await within(
      cdp.send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: 'location.href', returnByValue: true }),
      CAPTURE_TIMEOUT_MS,
      'location.href',
    );
    return typeof r.result?.value === 'string' ? r.result.value : undefined;
  } catch {
    return undefined;
  }
}
