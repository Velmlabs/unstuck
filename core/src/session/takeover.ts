import {
  encodeFrame,
  parseViewerMessage,
  type EngineToViewer,
  type SessionStatus,
  type TakeoverResult,
  type TakeoverStatus,
  type ViewerErrorCode,
} from '@unstuck/protocol';
import type { CdpClient } from '../cdp';
import type { EventLog } from '../events';
import type { Transport, ViewerConnection } from '../transport';
import { startScreencast } from '../stream/screencast';
import { applyInput } from '../stream/input';
import { createLatestSender } from '../stream/latest';
import { nextStatus, isTerminal, type SessionEvent } from './status';
import { newSessionId, signToken, verifyToken } from './tokens';

export const HELLO_TIMEOUT_MS = 10_000;
export const RESUME_WINDOW_MS = 60_000;
export const DRAIN_INTERVAL_MS = 50;

export interface LinkInfo {
  sessionId: string;
  url: string;
  reason: string;
  expiresAt: number;
}

export interface TakeoverDeps {
  transport: Transport;
  key: CryptoKey;
  log?: EventLog;
  now: () => number;
}

export interface TakeoverOptions {
  reason: string;
  timeoutS: number;
  site?: string;
  onLink?: (info: LinkInfo) => void;
  /** Set when the page closed before the session started (caller subscribed earlier). */
  closedBefore?: string;
}

export interface RunningTakeover {
  result: Promise<TakeoverResult>;
  cancel(detail: string): void;
}

const FINAL_EVENT: Record<TakeoverStatus, SessionEvent> = {
  resolved: 'done',
  cancelled: 'cancel',
  timed_out: 'timeout',
  failed: 'error',
};

const errorText: Record<ViewerErrorCode, string> = {
  token_invalid: 'This link is not valid.',
  token_used: 'This link is already in use on another device.',
  expired: 'This link has expired.',
  session_closed: 'This takeover has ended.',
  bad_message: 'Unexpected message.',
};

/** Runs one takeover session. The returned promise never rejects. */
export function runTakeover(deps: TakeoverDeps, cdp: CdpClient, opts: TakeoverOptions): RunningTakeover {
  const { transport, key, log, now } = deps;
  const sessionId = newSessionId();
  const startedAt = now();
  const expiresAt = startedAt + opts.timeoutS * 1000;
  let status: SessionStatus = 'created';
  let url = '';
  let published = false;
  let redeemed = false;
  let holder: ViewerConnection | null = null;
  let resumeKey: string | null = null;
  let leftAt: number | null = null;
  let inputCount = 0;
  let stopScreencast: (() => Promise<void>) | null = null;
  let sender: ReturnType<typeof createLatestSender> | null = null;
  let drainTimer: ReturnType<typeof setInterval> | null = null;
  let inputChain: Promise<void> = Promise.resolve();
  const helloTimers = new Set<ReturnType<typeof setTimeout>>();
  let resolveResult!: (r: TakeoverResult) => void;
  const result = new Promise<TakeoverResult>((r) => (resolveResult = r));

  const emit = (type: Parameters<EventLog['append']>[0]['type'], data?: Record<string, string | number | boolean>) =>
    log?.append({ ts: now(), sessionId, type, ...(data ? { data } : {}) });
  const sendJson = (c: ViewerConnection, m: EngineToViewer) => c.send(JSON.stringify(m));
  const reject = (c: ViewerConnection, code: ViewerErrorCode, close = true) => {
    sendJson(c, { t: 'error', code, message: errorText[code] });
    if (close) c.close(1008, code);
  };
  const go = (ev: SessionEvent) => {
    status = nextStatus(status, ev);
    emit('status', { status });
  };

  const expiryTimer = setTimeout(() => finish('timed_out'), Math.max(0, expiresAt - startedAt));
  const offClose = cdp.onClose(() => finish('failed', 'page_closed'));

  async function stopStream(): Promise<void> {
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = null;
    sender = null;
    const stop = stopScreencast;
    stopScreencast = null;
    if (stop) await stop();
  }

  function finish(final: TakeoverStatus, detail?: string): void {
    if (isTerminal(status)) return;
    status = nextStatus(status, FINAL_EVENT[final]);
    clearTimeout(expiryTimer);
    for (const t of helloTimers) clearTimeout(t);
    helloTimers.clear();
    offClose();
    const viewer = holder;
    holder = null;
    if (viewer) {
      sendJson(viewer, { t: 'state', status });
      viewer.close(1000, status);
    }
    const durationS = Math.round(now() - startedAt) / 1000;
    void (async () => {
      await stopStream();
      if (published) await transport.unpublish(sessionId).catch(() => {});
      emit('finished', { status: final, durationS, inputCount, ...(detail ? { detail } : {}) });
      resolveResult({ status: final, sessionId, url, durationS, ...(detail ? { detail } : {}) });
    })();
  }

  async function attachViewer(conn: ViewerConnection): Promise<void> {
    const previous = holder;
    holder = conn;
    leftAt = null;
    if (previous && previous !== conn) previous.close(1000, 'replaced');
    resumeKey = newSessionId();
    if (status === 'waiting') go('viewer_joined');
    emit('viewer_joined');
    sendJson(conn, { t: 'ready', reason: opts.reason, site: opts.site ?? '', expiresAt, resumeKey });
    sender = createLatestSender(conn);
    if (stopScreencast) return;
    try {
      stopScreencast = await startScreencast(cdp, (f) => sender?.push(encodeFrame(f)));
    } catch (e) {
      finish('failed', `cdp_error: ${(e as Error).message}`);
      return;
    }
    if (holder === null || isTerminal(status)) return void stopStream();
    drainTimer = setInterval(() => sender?.drain(), DRAIN_INTERVAL_MS);
  }

  function detachViewer(conn: ViewerConnection): void {
    if (holder !== conn || isTerminal(status)) return;
    holder = null;
    leftAt = now();
    go('viewer_left');
    emit('viewer_left');
    void stopStream();
  }

  async function onHello(conn: ViewerConnection, token: string, offeredResumeKey?: string): Promise<boolean> {
    const check = await verifyToken(key, token, now());
    if (isTerminal(status)) {
      reject(conn, 'session_closed');
      return false;
    }
    if (!check.ok || check.sessionId !== sessionId) {
      reject(conn, check.ok ? 'token_invalid' : check.code);
      emit('viewer_rejected', { code: check.ok ? 'token_invalid' : check.code });
      return false;
    }
    const resumeOk =
      offeredResumeKey !== undefined &&
      offeredResumeKey === resumeKey &&
      (holder !== null || (leftAt !== null && now() - leftAt <= RESUME_WINDOW_MS));
    if (redeemed && !resumeOk) {
      reject(conn, 'token_used');
      emit('viewer_rejected', { code: 'token_used' });
      return false;
    }
    redeemed = true;
    await attachViewer(conn);
    return true;
  }

  function handleInput(conn: ViewerConnection, raw: string | Uint8Array): void {
    const msg = typeof raw === 'string' ? parseViewerMessage(raw) : null;
    if (!msg || msg.t === 'hello') return reject(conn, 'bad_message', false);
    switch (msg.t) {
      case 'ping':
        return sendJson(conn, { t: 'pong' });
      case 'done':
        return finish('resolved');
      case 'cant_solve':
        return finish('cancelled', msg.reason || 'cant_solve');
      default:
        inputCount++;
        inputChain = inputChain
          .then(() => applyInput(cdp, msg))
          .catch((e: Error) => finish('failed', `cdp_error: ${e.message}`));
    }
  }

  function onConnection(conn: ViewerConnection): void {
    if (isTerminal(status)) return reject(conn, 'session_closed');
    let greeted = false;
    let greeting = false;
    const helloTimer = setTimeout(() => {
      helloTimers.delete(helloTimer);
      if (!greeted) conn.close(1008, 'hello timeout');
    }, HELLO_TIMEOUT_MS);
    helloTimers.add(helloTimer);
    conn.onClose(() => {
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      detachViewer(conn);
    });
    conn.onMessage((raw) => {
      if (greeted) return handleInput(conn, raw);
      if (greeting) return;
      const msg = typeof raw === 'string' ? parseViewerMessage(raw) : null;
      if (!msg || msg.t !== 'hello') return reject(conn, 'bad_message');
      greeting = true;
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      void onHello(conn, msg.token, msg.resumeKey).then((ok) => {
        greeted = ok;
        greeting = false;
      });
    });
  }

  void (async () => {
    emit('created');
    if (opts.closedBefore !== undefined) return finish('failed', 'page_closed');
    try {
      const { baseUrl } = await transport.publish(sessionId);
      published = true;
      if (isTerminal(status)) return void transport.unpublish(sessionId).catch(() => {});
      transport.onConnection(sessionId, onConnection);
      const token = await signToken(key, sessionId, expiresAt);
      url = `${baseUrl}#t=${token}`;
    } catch (e) {
      return finish('failed', `publish_error: ${(e as Error).message}`);
    }
    if (isTerminal(status)) return;
    go('published');
    emit('published');
    // Notifiers arrive in Plan 4; until then "notifying" completes immediately.
    go('notified');
    emit('link', { expiresAt });
    opts.onLink?.({ sessionId, url, reason: opts.reason, expiresAt });
  })();

  return { result, cancel: (detail) => finish('cancelled', detail) };
}
