import {
  RESUME_WINDOW_MS,
  parseViewerMessage,
  type AskAnswer,
  type EngineToViewer,
  type SessionStatus,
  type ViewerErrorCode,
  type ViewerToEngine,
} from '@velmlabs/unstuck-protocol';
import type { ViewerConnection } from '../transport';
import { newSessionId, verifyToken } from './tokens';

export const HELLO_TIMEOUT_MS = 10_000;
/**
 * How long `end` waits for the holder's connection to close once the final `state` is on its way. A session unpublishes
 * after that, and a relay closes the viewer's socket when it is unpublished, so without the wait the person could miss
 * the result ("Answer sent") and see the session as gone. Bounded: a dead connection must not stall the agent's result.
 */
export const END_DELIVERY_MS = 2_000;
/** Wrong 6-digit codes before the link stops admitting anyone new (relay spec §5.8). */
export const MAX_CODE_ATTEMPTS = 5;

const errorText: Record<ViewerErrorCode, string> = {
  token_invalid: 'This link is not valid.',
  token_used: 'This link is already in use on another device.',
  expired: 'This link has expired.',
  session_closed: 'This takeover has ended.',
  bad_message: 'Unexpected message.',
  code_required: 'Enter the 6-digit code from your notification.',
  code_invalid: 'That code is not right.',
};

export interface GateOptions {
  key: CryptoKey;
  sessionId: string;
  now: () => number;
  /** The 6-digit code a new device must enter; none asked when absent. */
  code?: string;
  isEnded(): boolean;
  emit(type: string, data?: Record<string, string | number | boolean>): void;
  /** An admitted viewer (first hello, or a resume): send ready, start whatever the mode shows. */
  onAttach(conn: ViewerConnection, vn?: string): Promise<void>;
  /** The holder left (not called for a replaced or rejected connection). */
  onDetach(conn: ViewerConnection): void;
  /** Any message after an accepted hello, already parsed (the gate itself answers an unparsable one or a repeated hello with bad_message). */
  onMessage(conn: ViewerConnection, msg: ViewerToEngine): void;
}

export interface ViewerGate {
  onConnection(conn: ViewerConnection): void;
  holder(): ViewerConnection | null;
  /** Someone has been admitted (true from the first accepted hello on, also after they left). */
  joined(): boolean;
  resumeKey(): string | null;
  /**
   * The path to humans came back after being down: if the holder has left and nobody has resumed, their resume
   * window restarts in full from now. Returns whether it did (the session then restarts its own viewer-left timer).
   */
  renewResumeWindow(): boolean;
  /**
   * On finish: clears hello timers, sends `state` (with `answer` when given) to the holder and closes it. Resolves once
   * that connection has closed (what was queued on it, the state included, went out first), or after END_DELIVERY_MS;
   * at once when nobody holds the session. Unpublish only after it. Never rejects.
   */
  end(status: SessionStatus, answer?: AskAnswer): Promise<void>;
  reject(conn: ViewerConnection, code: ViewerErrorCode, close?: boolean): void;
}

/**
 * Admits viewers to one session: the hello (token, 6-digit code, resume key), the one-device rule and hello timeouts.
 *
 * The gate owns who holds the session (`holder`), whether the link was redeemed, the current resume key and when the
 * holder left (the resume window). Before `onAttach` it has made the connection the holder, closed a previous holder
 * as `replaced` and minted a fresh resume key (read it with `resumeKey()` for the `ready` frame). When the holder's
 * connection closes, the gate clears the holder and starts the resume window, then calls `onDetach`; a session that
 * pauses its own viewer-left timer while the path to humans is down calls `renewResumeWindow()` when it comes back.
 * Messages that arrive while a hello is being checked are queued and handled after it.
 */
export function createViewerGate(o: GateOptions): ViewerGate {
  const { key, sessionId, now, code } = o;
  let holder: ViewerConnection | null = null;
  let redeemed = false;
  let resumeKey: string | null = null;
  let leftAt: number | null = null;
  let wrongCodes = 0;
  const helloTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Connections whose close has completed (`end` must not wait for a close that already happened). */
  const closed = new WeakSet<ViewerConnection>();

  const sendJson = (c: ViewerConnection, m: EngineToViewer) => c.send(JSON.stringify(m));
  const reject = (c: ViewerConnection, code: ViewerErrorCode, close = true) => {
    sendJson(c, { t: 'error', code, message: errorText[code] });
    if (close) c.close(1008, code);
  };

  async function attach(conn: ViewerConnection, vn?: string): Promise<void> {
    const previous = holder;
    holder = conn;
    leftAt = null;
    if (previous && previous !== conn) previous.close(1000, 'replaced');
    resumeKey = newSessionId();
    await o.onAttach(conn, vn);
  }

  function detach(conn: ViewerConnection): void {
    if (holder !== conn || o.isEnded()) return;
    holder = null;
    leftAt = now();
    o.onDetach(conn);
  }

  async function onHello(conn: ViewerConnection, token: string, offeredResumeKey?: string, offeredCode?: string, vn?: string): Promise<boolean> {
    const check = await verifyToken(key, token, now());
    if (o.isEnded()) {
      reject(conn, 'session_closed');
      return false;
    }
    if (!check.ok || check.sessionId !== sessionId) {
      reject(conn, check.ok ? 'token_invalid' : check.code);
      o.emit('viewer_rejected', { code: check.ok ? 'token_invalid' : check.code });
      return false;
    }
    const resumeOk =
      offeredResumeKey !== undefined &&
      offeredResumeKey === resumeKey &&
      (holder !== null || (leftAt !== null && now() - leftAt <= RESUME_WINDOW_MS));
    if (code !== undefined && !resumeOk) {
      // Resume needs no code: the resume key proves it's the device that already entered it.
      if (wrongCodes >= MAX_CODE_ATTEMPTS) {
        reject(conn, 'session_closed');
        o.emit('viewer_rejected', { code: 'code_locked' });
        return false;
      }
      if (offeredCode === undefined) {
        reject(conn, 'code_required', false);
        return false;
      }
      if (!sameCode(offeredCode, code)) {
        wrongCodes++;
        reject(conn, 'code_invalid', false);
        o.emit('viewer_rejected', { code: 'code_invalid' });
        return false;
      }
    }
    if (redeemed && !resumeOk) {
      reject(conn, 'token_used');
      o.emit('viewer_rejected', { code: 'token_used' });
      return false;
    }
    redeemed = true;
    await attach(conn, vn);
    return true;
  }

  function onConnection(conn: ViewerConnection): void {
    if (o.isEnded()) return reject(conn, 'session_closed');
    let greeted = false;
    let greeting = false;
    const helloTimer = setTimeout(() => {
      helloTimers.delete(helloTimer);
      if (!greeted) conn.close(1008, 'hello timeout');
    }, HELLO_TIMEOUT_MS);
    helloTimers.add(helloTimer);
    conn.onClose(() => {
      closed.add(conn);
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      detach(conn);
    });
    // Messages that arrive while a hello is being handled (e.g. Done tapped the moment the screen appears)
    // wait their turn instead of being dropped.
    const waiting: (string | Uint8Array)[] = [];
    const dispatch = (raw: string | Uint8Array): void => {
      if (greeting) return void waiting.push(raw);
      const msg = typeof raw === 'string' ? parseViewerMessage(raw) : null;
      if (greeted) return !msg || msg.t === 'hello' ? reject(conn, 'bad_message', false) : o.onMessage(conn, msg);
      if (!msg || msg.t !== 'hello') return reject(conn, 'bad_message');
      greeting = true;
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      void onHello(conn, msg.token, msg.resumeKey, msg.code, msg.vn).then((ok) => {
        greeted = ok;
        greeting = false;
        for (const next of waiting.splice(0)) dispatch(next);
      });
    };
    conn.onMessage(dispatch);
  }

  function renewResumeWindow(): boolean {
    if (holder !== null || leftAt === null) return false;
    leftAt = now();
    return true;
  }

  function end(status: SessionStatus, answer?: AskAnswer): Promise<void> {
    for (const t of helloTimers) clearTimeout(t);
    helloTimers.clear();
    const viewer = holder;
    holder = null;
    if (!viewer || closed.has(viewer)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, END_DELIVERY_MS);
      viewer.onClose(() => {
        clearTimeout(timer);
        resolve();
      });
      sendJson(viewer, { t: 'state', status, ...(answer ? { answer } : {}) });
      viewer.close(1000, status);
    });
  }

  return {
    onConnection,
    holder: () => holder,
    joined: () => redeemed,
    resumeKey: () => resumeKey,
    renewResumeWindow,
    end,
    reject,
  };
}

/** Constant-time comparison of two 6-digit strings. */
function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
