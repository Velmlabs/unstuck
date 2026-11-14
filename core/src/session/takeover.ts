import {
  RESUME_WINDOW_MS,
  b64urlEncode,
  importE2eKey,
  newE2eKey,
  encodeFrame,
  parseViewerMessage,
  type EngineToViewer,
  type SessionStatus,
  type TakeoverResult,
  type TakeoverStatus,
  type ViewerErrorCode,
} from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';
import type { EventLog } from '../events';
import type { Transport, ViewerConnection } from '../transport';
import { startScreencast } from '../stream/screencast';
import { startScreenshotPolling } from '../stream/poll';
import { probeCapabilities, type Capabilities } from '../capabilities';
import { applyInput } from '../stream/input';
import { scanFields, focusedField } from '../stream/fields';
import { browserPlatformIsMac, translateShortcut } from '../stream/shortcuts';
import { createFieldFeed } from './field-feed';
import { lockPage, safeInput, type PageLock } from './page-lock';
import { createLatestSender } from '../stream/latest';
import { nextStatus, isTerminal, type SessionEvent } from './status';
import { newSessionId, signToken, verifyToken } from './tokens';
import { sealConnection } from './sealed';

export const HELLO_TIMEOUT_MS = 10_000;
export { RESUME_WINDOW_MS };
/** Wrong 6-digit codes before the link stops admitting anyone new (relay spec §5.8). */
export const MAX_CODE_ATTEMPTS = 5;
export const DRAIN_INTERVAL_MS = 50;
/** Upper bound on waiting for CDP during cleanup, so a dead browser can never stall the result. */
export const STOP_TIMEOUT_MS = 2_000;

export interface LinkInfo {
  sessionId: string;
  url: string;
  reason: string;
  expiresAt: number;
  /** The 6-digit code the human must enter, when required. Never part of the URL. */
  code?: string;
}

export interface TakeoverDeps {
  transport: Transport;
  key: CryptoKey;
  log?: EventLog;
  now: () => number;
}

/** Pages the agent's page opens (e.g. a CAPTCHA provider's popup). */
export interface PopupSource {
  onPopup(cb: (popup: CdpClient) => void): () => void;
}

interface Target {
  cdp: CdpClient;
  caps: Capabilities;
  off: () => void;
  /** Keeps the target on its site while the human controls it. */
  lock?: PageLock;
}

export interface TakeoverOptions {
  reason: string;
  timeoutS: number;
  site?: string;
  onLink?: (info: LinkInfo) => void;
  /** Set when the page closed before the session started (caller subscribed earlier). */
  closedBefore?: string;
  /** Popups to follow: the newest open popup is what the human sees and controls. */
  popups?: PopupSource;
  /** Ask the human for a 6-digit code delivered with the link. */
  requireCode?: boolean;
  /** Sites besides the page's own that the human may navigate the page to. */
  allowedSites?: string[];
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
  code_required: 'Enter the 6-digit code from your notification.',
  code_invalid: 'That code is not right.',
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
  /** Bumped by every start and stop: a start that resolves with a stale generation shuts itself down. */
  let streamGen = 0;
  let sender: ReturnType<typeof createLatestSender> | null = null;
  let drainTimer: ReturnType<typeof setInterval> | null = null;
  let leftTimer: ReturnType<typeof setTimeout> | null = null;
  /** The path to humans (e.g. the relay) is down: the viewer-left timer is paused meanwhile. */
  let transportDown = false;
  const code = opts.requireCode ? newCode() : undefined;
  let wrongCodes = 0;
  let lastFrame: Uint8Array | null = null;
  let caps: Capabilities = { screencast: true, insertText: true, input: true };
  /** The page's site and the agent-listed sites; popups may visit these too. */
  let pageSites: readonly string[] = [];
  /** A navigation the page lock stopped: logged by host only (a URL can carry secrets). */
  const onBlocked = (url: string) => {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      // not a URL: logged without a host
    }
    emit('navigation_blocked', { host });
  };
  /** Stack of controllable targets: [page, ...open popups]; the last one is shown to the human. */
  const targets: Target[] = [];
  const active = (): Target => targets[targets.length - 1] ?? { cdp, caps, off: () => {} };
  let offPopups: () => void = () => {};
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
  /** Native typing: where the fields are on the shown page, and what took focus (never their values). */
  const fieldFeed = createFieldFeed({
    scan: () => scanFields(active().cdp),
    focus: () => focusedField(active().cdp),
    send: (m) => void (holder && sendJson(holder, m)),
  });
  const go = (ev: SessionEvent) => {
    status = nextStatus(status, ev);
    emit('status', { status });
  };

  const expiryTimer = setTimeout(() => finish('timed_out'), Math.max(0, expiresAt - startedAt));
  const offClose = cdp.onClose(() => finish('failed', 'page_closed'));

  async function stopStream(): Promise<void> {
    streamGen++; // invalidates any start still in flight
    if (drainTimer) clearInterval(drainTimer);
    drainTimer = null;
    sender = null;
    const stop = stopScreencast;
    stopScreencast = null;
    if (!stop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([stop(), new Promise<void>((r) => (timer = setTimeout(r, STOP_TIMEOUT_MS)))]);
    clearTimeout(timer);
  }

  /** `logged` replaces what the audit log records for `detail` (the human's own words are never logged). */
  function finish(final: TakeoverStatus, detail?: string, logged?: Record<string, string | number>): void {
    if (isTerminal(status)) return;
    status = nextStatus(status, FINAL_EVENT[final]);
    clearTimeout(expiryTimer);
    if (leftTimer) clearTimeout(leftTimer);
    for (const t of helloTimers) clearTimeout(t);
    helloTimers.clear();
    offClose();
    offPopups();
    fieldFeed.stop();
    for (const t of targets) t.off();
    const locks = targets.map((t) => t.lock);
    const viewer = holder;
    holder = null;
    if (viewer) {
      sendJson(viewer, { t: 'state', status });
      viewer.close(1000, status);
    }
    const durationS = Math.round(now() - startedAt) / 1000;
    void (async () => {
      await stopStream();
      // Unlocking talks to the page, which may never answer (SDK gone, page closed): bounded like stopping the stream.
      let unlockTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(locks.map((l) => l?.stop())), new Promise<void>((r) => (unlockTimer = setTimeout(r, STOP_TIMEOUT_MS)))]);
      clearTimeout(unlockTimer);
      if (published) await transport.unpublish(sessionId).catch(() => {});
      emit('finished', { status: final, durationS, inputCount, ...(logged ?? (detail ? { detail } : {})) });
      const fallbacks = [!caps.screencast && 'screenshots', !caps.insertText && 'per-key typing'].filter(Boolean).join(', ');
      const shown = detail ?? (fallbacks ? `fallback: ${fallbacks}` : undefined);
      resolveResult({ status: final, sessionId, url, durationS, ...(shown ? { detail: shown } : {}) });
    })();
  }

  async function attachViewer(conn: ViewerConnection): Promise<void> {
    const previous = holder;
    holder = conn;
    leftAt = null;
    if (leftTimer) clearTimeout(leftTimer);
    leftTimer = null;
    if (previous && previous !== conn) previous.close(1000, 'replaced');
    resumeKey = newSessionId();
    if (status === 'waiting') go('viewer_joined');
    emit('viewer_joined');
    sendJson(conn, { t: 'ready', reason: opts.reason, site: opts.site ?? '', expiresAt, resumeKey });
    sender = createLatestSender(conn);
    // Chrome only sends frames when the page repaints; a static CAPTCHA would leave a new viewer black.
    if (lastFrame) sender.push(lastFrame);
    fieldFeed.onTargetChanged(); // the new viewer needs the current map even if it hasn't changed
    if (!stopScreencast) await startStream();
  }

  /** Streams the active target to the current holder. */
  async function startStream(): Promise<void> {
    const gen = ++streamGen;
    const target = active();
    let stop: () => Promise<void>;
    try {
      const startFrames = target.caps.screencast ? startScreencast : startScreenshotPolling;
      stop = await startFrames(target.cdp, (f) => {
        if (gen !== streamGen) return;
        lastFrame = encodeFrame(f);
        sender?.push(lastFrame);
        fieldFeed.onFrame();
      });
    } catch (e) {
      if (gen === streamGen) onTargetError(target, e as Error);
      return;
    }
    // Superseded while starting (viewer replaced, popup switch, finish): stop this one.
    if (gen !== streamGen || holder === null || isTerminal(status)) return void stop().catch(() => {});
    stopScreencast = stop;
    drainTimer = setInterval(() => sender?.drain(), DRAIN_INTERVAL_MS);
  }

  /** A CDP error fails the takeover only when it comes from the page; a popup that errors is gone. */
  function onTargetError(target: Target, e: Error): void {
    if (target.cdp === cdp) return finish('failed', `cdp_error: ${e.message}`);
    removeTarget(target);
  }

  /** The active target changed: move the stream to it. */
  async function switchStream(): Promise<void> {
    if (!holder || isTerminal(status)) return;
    await stopStream();
    lastFrame = null;
    if (!holder || isTerminal(status)) return;
    sender = createLatestSender(holder);
    fieldFeed.onTargetChanged();
    await startStream();
  }

  async function addPopup(popup: CdpClient): Promise<void> {
    if (isTerminal(status)) return;
    let entry: Target | null = null;
    let gone = false;
    const off = popup.onClose(() => {
      gone = true;
      if (entry) removeTarget(entry);
    });
    const popupCaps = await probeCapabilities(popup);
    if (gone || !popupCaps.input || isTerminal(status)) return void off();
    // Locked like the page (its site, the listed sites, and the site the popup itself opens): a popup that can't be
    // locked is never shown to the human.
    const lock = await lockPage(popup, { allowedSites: [...(opts.allowedSites ?? []), ...pageSites], adoptFirstSite: true, onBlocked }).catch(() => null);
    if (!lock || gone || isTerminal(status)) {
      void lock?.stop();
      return void off();
    }
    entry = { cdp: popup, caps: popupCaps, off, lock };
    targets.push(entry);
    await switchStream();
  }

  function removeTarget(entry: Target): void {
    const i = targets.indexOf(entry);
    if (i <= 0) return; // the page itself never leaves the stack
    const wasActive = i === targets.length - 1;
    targets.splice(i, 1);
    entry.off();
    void entry.lock?.stop();
    if (wasActive) void switchStream();
  }

  function detachViewer(conn: ViewerConnection): void {
    if (holder !== conn || isTerminal(status)) return;
    holder = null;
    leftAt = now();
    go('viewer_left');
    emit('viewer_left');
    void stopStream();
    if (!transportDown) startLeftTimer();
  }

  function startLeftTimer(): void {
    if (leftTimer) clearTimeout(leftTimer);
    // If nobody resumes in time, nobody can ever rejoin (the token is spent): free the agent now.
    leftTimer = setTimeout(() => finish('failed', 'viewer_left'), RESUME_WINDOW_MS);
  }

  function onTransportStatus(s: 'up' | 'down'): void {
    if (isTerminal(status)) return;
    transportDown = s === 'down';
    if (transportDown) {
      if (leftTimer) clearTimeout(leftTimer);
      leftTimer = null;
    } else if (holder === null && leftAt !== null) {
      leftAt = now(); // the resume window restarts in full once humans can reach us again
      startLeftTimer();
    }
  }

  async function onHello(conn: ViewerConnection, token: string, offeredResumeKey?: string, offeredCode?: string): Promise<boolean> {
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
    if (code !== undefined && !resumeOk) {
      // Resume needs no code: the resume key proves it's the device that already entered it.
      if (wrongCodes >= MAX_CODE_ATTEMPTS) {
        reject(conn, 'session_closed');
        emit('viewer_rejected', { code: 'code_locked' });
        return false;
      }
      if (offeredCode === undefined) {
        reject(conn, 'code_required', false);
        return false;
      }
      if (!sameCode(offeredCode, code)) {
        wrongCodes++;
        reject(conn, 'code_invalid', false);
        emit('viewer_rejected', { code: 'code_invalid' });
        return false;
      }
    }
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
      case 'cant_solve': {
        // Typed by the human and handed to the agent (often an AI): one clean line, and never written to the log.
        const reason = cleanReason(msg.reason ?? '');
        return finish('cancelled', reason || 'cant_solve', reason ? { detail: 'cant_solve', reasonLength: reason.length } : undefined);
      }
      default: {
        const safe = safeInput(msg);
        if (!safe) return;
        inputCount++;
        inputChain = inputChain.then(async () => {
          const target = active();
          try {
            // Shortcuts follow the agent browser's system (Cmd+A from a Mac reaches a Linux browser as Ctrl+A).
            const msgs = safe.t === 'key' ? translateShortcut(safe, await browserPlatformIsMac(target.cdp)) : [safe];
            for (const m of msgs) await applyInput(target.cdp, m, target.caps);
          } catch (e) {
            return onTargetError(target, e as Error);
          }
          // After the input has landed, so a tap's new focus and a scroll's new positions are what gets scanned.
          fieldFeed.onInput(safe);
        });
      }
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
    // Messages that arrive while a hello is being handled (e.g. Done tapped the moment the screen appears)
    // wait their turn instead of being dropped.
    const waiting: (string | Uint8Array)[] = [];
    const dispatch = (raw: string | Uint8Array): void => {
      if (greeted) return handleInput(conn, raw);
      if (greeting) return void waiting.push(raw);
      const msg = typeof raw === 'string' ? parseViewerMessage(raw) : null;
      if (!msg || msg.t !== 'hello') return reject(conn, 'bad_message');
      greeting = true;
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      void onHello(conn, msg.token, msg.resumeKey, msg.code).then((ok) => {
        greeted = ok;
        greeting = false;
        for (const next of waiting.splice(0)) dispatch(next);
      });
    };
    conn.onMessage(dispatch);
  }

  void (async () => {
    if (opts.closedBefore !== undefined) {
      emit('created');
      return finish('failed', 'page_closed');
    }
    caps = await probeCapabilities(cdp);
    emit('created', { screencast: caps.screencast, insertText: caps.insertText, input: caps.input });
    if (isTerminal(status)) return; // the page closed while probing
    if (!caps.input) return finish('failed', 'browser does not support input');
    try {
      const lock = await lockPage(cdp, { allowedSites: opts.allowedSites ?? [], onBlocked });
      pageSites = lock.sites;
      targets.push({ cdp, caps, off: () => {}, lock });
    } catch {
      return finish('failed', 'page_lock_unavailable'); // never hand out a page that isn't locked
    }
    if (isTerminal(status)) return;
    if (opts.popups) offPopups = opts.popups.onPopup((popup) => void addPopup(popup));
    try {
      const rawE2e = newE2eKey();
      const e2eKey = await importE2eKey(rawE2e);
      const { baseUrl } = await transport.publish(sessionId, { expiresAt });
      published = true;
      if (isTerminal(status)) return void transport.unpublish(sessionId).catch(() => {});
      transport.onConnection(sessionId, (conn) => onConnection(sealConnection(conn, e2eKey, sessionId)));
      transport.onStatus?.(sessionId, onTransportStatus);
      const token = await signToken(key, sessionId, expiresAt);
      url = `${baseUrl}#t=${token}&k=${b64urlEncode(rawE2e)}`;
    } catch (e) {
      // A relay says why it refused (relay_unauthorized, relay_quota_exceeded, ...): pass that through.
      const detail = (e as { detail?: unknown }).detail;
      return finish('failed', typeof detail === 'string' ? detail : `publish_error: ${(e as Error).message}`);
    }
    if (isTerminal(status)) return;
    go('published');
    emit('published');
    // Notifiers arrive in Plan 4; until then "notifying" completes immediately.
    go('notified');
    emit('link', { expiresAt });
    opts.onLink?.({ sessionId, url, reason: opts.reason, expiresAt, ...(code !== undefined ? { code } : {}) });
  })();

  return { result, cancel: (detail) => finish('cancelled', detail) };
}

/** Uniform 000000–999999 from the CSPRNG (rejection sampling avoids modulo bias). */
function newCode(): string {
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= 4_294_000_000);
  return String(buf[0]! % 1_000_000).padStart(6, '0');
}

/** Constant-time comparison of two 6-digit strings. */
function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The human's "Can't solve" text as one plain line: no control, format or bidi characters, spaces collapsed. */
export function cleanReason(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
