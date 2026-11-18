import type { AlertKind, AskParams, AskResult, TakeoverResult } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from './cdp';
import type { EventLog } from './events';
import type { Transport } from './transport';
import { importSecret, newSecret } from './session/tokens';
import { CAPTURE_TIMEOUT_MS, within } from './stream/within';
import { runTakeover, type LinkHandler, type PopupSource, type RunningTakeover } from './session/takeover';
import { cleanAgentName } from './session/agent-name';
import { ASK_TIMEOUT_S, checkAsk, runAsk } from './session/ask';

export type { LinkHandler, LinkInfo, PopupSource, TakeoverControl } from './session/takeover';

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

export type AskCallOptions = AskParams & {
  onLink?: LinkHandler;
  /** Shown to the person with the question. */
  agentName?: string;
};

export interface Engine {
  /** Never rejects: every failure becomes a TakeoverResult. */
  takeover(cdp: CdpClient, opts: TakeoverCallOptions): Promise<TakeoverResult>;
  /**
   * Asks the person a question (no browser page). Rejects only with a TypeError (the checkAsk message) when the params
   * are out of range, always asynchronously; otherwise never rejects: every failure becomes an AskResult. `alerts` is
   * for the link handler: the engine itself ignores it.
   */
  ask(opts: AskCallOptions): Promise<AskResult>;
  /** Cancels in-flight takeovers and questions (detail `engine_closed`) and closes the transport; later takeovers end the same way. */
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
      const agentName = cleanAgentName(call.agentName);
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
        ...(agentName ? { agentName } : {}),
        ...(approvalSince !== undefined ? { approvalSince } : {}),
      });
      running.add(session);
      try {
        return await session.result;
      } finally {
        running.delete(session);
      }
    },
    async ask(call) {
      const problem = checkAsk(call);
      if (problem) throw new TypeError(problem);
      const agentName = cleanAgentName(call.agentName);
      const k = await key;
      if (closed) return { status: 'cancelled', sessionId: '', durationS: 0, detail: 'engine_closed' };
      const session = runAsk(
        { transport: opts.transport, key: k, log: opts.log, now },
        {
          question: call.question,
          ...(call.choices ? { choices: call.choices } : {}),
          allowText: call.allowText ?? !call.choices,
          ...(call.details !== undefined ? { details: call.details } : {}),
          timeoutS: call.timeoutS ?? ASK_TIMEOUT_S,
          ...(agentName ? { agentName } : {}),
          quickAnswers: call.private === false,
          onLink: call.onLink ?? opts.onLink,
          requireCode: opts.requireCode,
        },
      );
      running.add(session);
      try {
        const r = await session.result;
        // A question session never ends `resolved` (it has no Done), so the status is an AskResult one.
        return {
          status: r.status as AskResult['status'],
          ...(r.answer ? { answer: r.answer } : {}),
          ...(r.via ? { via: r.via } : {}),
          durationS: r.durationS,
          sessionId: r.sessionId,
          ...(r.detail ? { detail: r.detail } : {}),
        };
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
