// A question session (`ask`): no browser page. The agent asks, the person answers on a private page (or, for a
// question that isn't private, with a quick-answer button the transport relays), and the agent gets the answer.
import type { AskAnswer, AskParams, EngineToViewer, SessionStatus, TakeoverResult, TakeoverStatus, ViewerToEngine } from '@velmlabs/unstuck-protocol';
import type { UnstuckEventType } from '../events';
import type { ViewerConnection } from '../transport';
import { nextStatus, isTerminal, type SessionEvent } from './status';
import { newSessionId } from './tokens';
import { createViewerGate } from './gate';
import { createResumeWatch, publishLink } from './link';
import { FINAL_EVENT, cleanLine, newCode, type LinkHandler, type LinkInfo, type RunningTakeover, type TakeoverDeps } from './takeover';

export const ASK_LIMITS = {
  question: 300,
  choices: { min: 2, max: 6, label: 80 },
  details: 1000,
  timeoutS: { min: 10, max: 3600 },
} as const;
/** Typed answers longer than this are cut (the viewer protocol refuses longer ones anyway). */
export const MAX_ANSWER_TEXT = 500;
export const ASK_TIMEOUT_S = 600;

export interface AskSessionOptions {
  question: string;
  choices?: string[];
  allowText: boolean;
  details?: string;
  timeoutS: number;
  agentName?: string;
  /** Accept the transport's quick answers (only for a question that isn't private). */
  quickAnswers: boolean;
  onLink?: LinkHandler;
  requireCode?: boolean;
}

/** Why `p` can't be asked, or null. Checks types too: the params may come straight from an RPC call. */
export function checkAsk(p: AskParams): string | null {
  const { question, choices, details, timeoutS } = p as { [k in keyof AskParams]?: unknown };
  if (typeof question !== 'string' || !question.trim() || question.length > ASK_LIMITS.question) return 'question must be 1-300 characters';
  if (
    choices !== undefined &&
    (!Array.isArray(choices) ||
      choices.length < ASK_LIMITS.choices.min ||
      choices.length > ASK_LIMITS.choices.max ||
      !choices.every((c) => typeof c === 'string' && c.trim() !== '' && c.length <= ASK_LIMITS.choices.label))
  )
    return 'choices must be 2-6 labels of at most 80 characters';
  if (details !== undefined && (typeof details !== 'string' || details.length > ASK_LIMITS.details)) return 'details must be at most 1000 characters';
  if (timeoutS !== undefined && (typeof timeoutS !== 'number' || !(timeoutS >= ASK_LIMITS.timeoutS.min && timeoutS <= ASK_LIMITS.timeoutS.max)))
    return 'timeoutS must be 10-3600';
  return null;
}

/** Runs one question session. The returned promise never rejects. */
export function runAsk(deps: TakeoverDeps, o: AskSessionOptions): RunningTakeover {
  const { transport, key, log, now } = deps;
  const sessionId = newSessionId();
  const startedAt = now();
  const expiresAt = startedAt + o.timeoutS * 1000;
  const code = o.requireCode ? newCode() : undefined;
  const choices = o.choices ?? [];
  let status: SessionStatus = 'created';
  let url = '';
  let published = false;
  let resolveResult!: (r: TakeoverResult) => void;
  const result = new Promise<TakeoverResult>((r) => (resolveResult = r));

  const emit = (type: UnstuckEventType, data?: Record<string, string | number | boolean>) => log?.append({ ts: now(), sessionId, type, ...(data ? { data } : {}) });
  const sendJson = (c: ViewerConnection, m: EngineToViewer) => c.send(JSON.stringify(m));
  const isEnded = () => isTerminal(status);
  const go = (ev: SessionEvent) => {
    status = nextStatus(status, ev);
    emit('status', { status });
  };
  const gate = createViewerGate({
    key,
    sessionId,
    now,
    ...(code !== undefined ? { code } : {}),
    isEnded,
    emit: (type, data) => emit(type as UnstuckEventType, data),
    onAttach: attachViewer,
    onDetach: detachViewer,
    onMessage: handleMessage,
  });
  const resume = createResumeWatch({ gate, isEnded, onLapse: () => finish('failed', 'viewer_left') });
  const expiryTimer = setTimeout(() => finish('timed_out'), Math.max(0, expiresAt - startedAt));

  /** The question's text and answers are the person's and the agent's: never written to the log. */
  function finish(final: TakeoverStatus, detail?: string, answer?: AskAnswer, via?: 'page' | 'telegram'): void {
    if (isEnded()) return;
    // Terminal before the gate ends, so it admits nobody new.
    status = nextStatus(status, FINAL_EVENT[final]);
    clearTimeout(expiryTimer);
    resume.stop();
    gate.end(status, answer);
    const durationS = Math.round(now() - startedAt) / 1000;
    void (async () => {
      if (published) await transport.unpublish(sessionId).catch(() => {});
      emit('finished', { status: final, durationS, ...(detail ? { detail } : {}), ...(via ? { via } : {}) });
      resolveResult({ status: final, sessionId, url, durationS, ...(detail ? { detail } : {}), ...(answer ? { answer, via } : {}) });
    })();
  }

  async function attachViewer(conn: ViewerConnection, vn?: string): Promise<void> {
    resume.attached();
    if (status === 'waiting') go('viewer_joined');
    emit('viewer_joined');
    // No frames in a question session, so no frame credit.
    sendJson(conn, { t: 'ready', reason: o.question, site: '', expiresAt, resumeKey: gate.resumeKey()!, ...(vn ? { vn } : {}) });
    sendJson(conn, {
      t: 'mode',
      mode: 'question',
      reason: o.question,
      site: '',
      ...(o.agentName ? { agentName: o.agentName } : {}),
      question: { text: o.question, ...(o.choices ? { choices: o.choices } : {}), allowText: o.allowText, ...(o.details !== undefined ? { details: o.details } : {}) },
    });
  }

  function detachViewer(): void {
    go('viewer_left');
    emit('viewer_left');
    resume.left();
  }

  const validChoice = (c: number) => Number.isInteger(c) && c >= 0 && c < choices.length;
  const chosen = (c: number): AskAnswer => ({ choice: c, label: choices[c]! });

  function handleMessage(conn: ViewerConnection, msg: ViewerToEngine): void {
    if (msg.t === 'ping') return sendJson(conn, { t: 'pong' });
    if (msg.t !== 'answer') return gate.reject(conn, 'bad_message', false);
    const text = msg.text === undefined ? '' : cleanLine(msg.text, MAX_ANSWER_TEXT);
    const choiceOk = msg.choice === undefined || validChoice(msg.choice);
    const textOk = msg.text === undefined || o.allowText;
    if (!choiceOk || !textOk || (msg.choice === undefined && !text)) return gate.reject(conn, 'bad_message', false);
    finish('answered', undefined, { ...(msg.choice !== undefined ? chosen(msg.choice) : {}), ...(text ? { text } : {}) }, 'page');
  }

  /** A tap outside the page: only for a question that opted in, only while it runs (the first answer wins). */
  function onQuickAnswer(choice: number): void {
    if (isEnded() || !validChoice(choice)) return;
    finish('answered', undefined, chosen(choice), 'telegram');
  }

  void (async () => {
    emit('created');
    const link = await publishLink({
      transport,
      key,
      sessionId,
      expiresAt,
      mode: 'question',
      gate,
      isEnded,
      onPublished: () => (published = true),
      onStatus: resume.onStatus,
    });
    if ('failed' in link) return finish('failed', link.failed);
    if (!('url' in link)) return;
    url = link.url;
    go('published');
    emit('published');
    go('notified');
    emit('link', { expiresAt });
    if (o.quickAnswers) transport.onQuickAnswer?.(sessionId, onQuickAnswer);
    try {
      const info: LinkInfo = { sessionId, url, reason: o.question, expiresAt, ...(code !== undefined ? { code } : {}), kind: 'question', mode: 'question' };
      o.onLink?.(info, { fail, cancel, joined: gate.joined, ended: result });
    } catch {
      // A link handler that throws is the caller's bug: the question keeps running (an alert may already be on its way).
    }
  })().catch((e: unknown) => finish('failed', `internal_error: ${(e as Error)?.message ?? String(e)}`));

  function fail(detail: string): void {
    finish('failed', detail);
  }
  function cancel(detail: string): void {
    finish('cancelled', detail);
  }

  return { result, ended: result, cancel, fail, joined: gate.joined };
}
