import {
  RESUME_WINDOW_MS,
  encodeFrame,
  type AlertKind,
  type EngineToViewer,
  type SessionMode,
  type SessionStatus,
  type TakeoverResult,
  type TakeoverStatus,
  type ViewerInput,
  type ViewerToEngine,
} from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';
import type { EventLog, UnstuckEventType } from '../events';
import type { Transport, ViewerConnection } from '../transport';
import { startScreencast } from '../stream/screencast';
import { startScreenshotPolling } from '../stream/poll';
import { probeCapabilities, type Capabilities } from '../capabilities';
import { applyInput } from '../stream/input';
import { scanFields, focusedField } from '../stream/fields';
import { browserPlatformIsMac, translateShortcut } from '../stream/shortcuts';
import { createFieldFeed } from './field-feed';
import { lockPage, safeInput, type PageLock } from './page-lock';
import { createLatestSender, type LatestSender } from '../stream/latest';
import { nextStatus, isTerminal, type SessionEvent } from './status';
import { newSessionId } from './tokens';
import { createViewerGate } from './gate';
import { createResumeWatch, publishLink } from './link';
import { watchApproval } from '../guard/approval-watch';
import { STILL_BLOCKED_PREFIX, checkApproval } from '../guard/approval-verdict';
import { CAPTURE_TIMEOUT_MS, within } from '../stream/within';

export { HELLO_TIMEOUT_MS, MAX_CODE_ATTEMPTS } from './gate';
export { RESUME_WINDOW_MS };
export const DRAIN_INTERVAL_MS = 50;
/** Upper bound on waiting for CDP during cleanup, so a dead browser can never stall the result. */
export const STOP_TIMEOUT_MS = 2_000;
/** Viewer input waiting to be replayed into the page; beyond this, pointer moves and wheels go first, then new input. */
export const MAX_PENDING_INPUT = 256;
/** In approval mode, the still preview is taken again this long after the page's last main-frame navigation. */
export const PREVIEW_DEBOUNCE_MS = 500;
const PREVIEW_QUALITY = 50;

/** Rejects a CDP call that a takeover's input queue may no longer make (the takeover ended, or the sender lost hold). */
const DROPPED = new Error('input dropped');

export interface LinkInfo {
  sessionId: string;
  url: string;
  reason: string;
  expiresAt: number;
  /** The 6-digit code the human must enter, when required. Never part of the URL. */
  code?: string;
  /** What the alert is about, when the caller said. */
  kind?: AlertKind;
  /** How the session starts: `control` (the person drives the page) or `approval` (a waiting page). */
  mode?: SessionMode;
}

/** What a link handler can do to the takeover it got the link for. */
export interface TakeoverControl {
  /** Ends the takeover at once as `failed` with this detail (e.g. `alert_failed`); nothing happens once it has ended. */
  fail(detail: string): void;
  /** Ends the takeover at once as `cancelled` with this detail (e.g. the agent stopped waiting); nothing happens once it has ended. */
  cancel(detail: string): void;
  /** Someone has opened the link and joined (true from the first accepted hello on, also after they left). */
  joined(): boolean;
  /** Settles with the takeover's result once it has ended (never rejects). */
  ended: Promise<TakeoverResult>;
}

/** Gets a session's link; `takeover.fail(detail)` ends that session as failed (e.g. when the link can't be delivered). */
export type LinkHandler = (info: LinkInfo, takeover: TakeoverControl) => void;

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
  onLink?: (info: LinkInfo, takeover: TakeoverControl) => void;
  /** Set when the page closed before the session started (caller subscribed earlier). */
  closedBefore?: string;
  /** Popups to follow: the newest open popup is what the human sees and controls. */
  popups?: PopupSource;
  /** Ask the human for a 6-digit code delivered with the link. */
  requireCode?: boolean;
  /** Sites besides the page's own that the human may navigate the page to. */
  allowedSites?: string[];
  /**
   * `approval`: the person gets a waiting page (one still preview, no input) while the page is watched for the sign-in
   * approval prompt to go away; they can switch to control. Default `control`.
   */
  mode?: 'control' | 'approval';
  kind?: AlertKind;
  /** Shown to the person in approval mode. */
  agentName?: string;
  /**
   * Approval mode: the page's URL when the prompt was found. The watcher runs only when it is given (it reports
   * `navigated` once the page has left this host and path).
   */
  approvalSince?: string;
}

export interface RunningTakeover extends TakeoverControl {
  result: Promise<TakeoverResult>;
}

export const FINAL_EVENT: Record<TakeoverStatus, SessionEvent> = {
  resolved: 'done',
  answered: 'answer',
  cancelled: 'cancel',
  timed_out: 'timeout',
  failed: 'error',
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
  let inputCount = 0;
  let stopScreencast: (() => Promise<void>) | null = null;
  /** Bumped by every start and stop: a start that resolves with a stale generation shuts itself down. */
  let streamGen = 0;
  /** Where stream frames go while a stream runs (null between streams). */
  let sender: LatestSender | null = null;
  /** The holder's sender, kept across popup switches so frame numbering and credit carry on. */
  let holderSender: LatestSender | null = null;
  let drainTimer: ReturnType<typeof setInterval> | null = null;
  const code = opts.requireCode ? newCode() : undefined;
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
  /** Input accepted from viewers, replayed one at a time (in order) by pumpInput(). */
  const pendingInput: { conn: ViewerConnection; input: ViewerInput }[] = [];
  let pumping = false;
  /** The dispatch in progress: finish() waits for it before unlocking the page. */
  let inFlight: Promise<void> | null = null;
  let inputDropped = 0;
  /** A mouse button the human pressed and has not released yet (where the pointer last was): released when ending. */
  let pressed: { target: Target; x: number; y: number; button: string; clickCount: number } | null = null;
  let resolveResult!: (r: TakeoverResult) => void;
  const result = new Promise<TakeoverResult>((r) => (resolveResult = r));
  /** The session started in approval mode (it sends `mode` frames; a control session never does). */
  const approvalSession = opts.mode === 'approval';
  /** What the person gets now: the waiting page (`approval`) until they switch to `control`. */
  let mode: 'control' | 'approval' = approvalSession ? 'approval' : 'control';
  /** Stops the approval watcher when the takeover ends. */
  const watch = new AbortController();
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  /** Approval mode: the page is being judged (the prompt went away, or the person said they approved). */
  let checking = false;
  let offNavigated: () => void = () => {};

  const emit = (type: Parameters<EventLog['append']>[0]['type'], data?: Record<string, string | number | boolean>) =>
    log?.append({ ts: now(), sessionId, type, ...(data ? { data } : {}) });
  const sendJson = (c: ViewerConnection, m: EngineToViewer) => c.send(JSON.stringify(m));
  const modeFrame = (): EngineToViewer => ({ t: 'mode', mode, reason: opts.reason, site: opts.site ?? '', ...(opts.agentName ? { agentName: opts.agentName } : {}) });
  /** Admission (hello, code, one device, resume key) and who holds the session; see gate.ts. */
  const gate = createViewerGate({
    key,
    sessionId,
    now,
    ...(code !== undefined ? { code } : {}),
    isEnded: () => isTerminal(status),
    emit: (type, data) => emit(type as UnstuckEventType, data),
    onAttach: attachViewer,
    onDetach: detachViewer,
    onMessage: handleInput,
  });
  const holder = gate.holder;
  /** The viewer-left deadline, paused while the path to humans (e.g. the relay) is down. */
  const resume = createResumeWatch({ gate, isEnded: () => isTerminal(status), onLapse: () => finish('failed', 'viewer_left') });
  /** Native typing: where the fields are on the shown page, and what took focus (never their values). */
  const fieldFeed = createFieldFeed({
    scan: () => scanFields(active().cdp),
    focus: () => focusedField(active().cdp),
    send: (m) => {
      const h = holder();
      if (h) sendJson(h, m);
    },
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
    sender?.clear();
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
    resume.stop();
    offClose();
    offPopups();
    offNavigated();
    watch.abort();
    if (previewTimer) clearTimeout(previewTimer);
    fieldFeed.stop();
    for (const t of targets) t.off();
    const locks = targets.map((t) => t.lock);
    gate.end(status);
    // No input from this takeover may reach the page once it has ended: what is still queued is discarded, the
    // dispatch in progress is waited for, and a button left pressed is released, all before the lock comes off.
    inputDropped += pendingInput.splice(0).length;
    const lastDispatch = inFlight;
    const durationS = Math.round(now() - startedAt) / 1000;
    void (async () => {
      await bounded((async () => {
        await lastDispatch;
        await releasePressed();
      })());
      await stopStream();
      // Unlocking talks to the page, which may never answer (SDK gone, page closed): bounded like stopping the stream.
      await bounded(Promise.all(locks.map((l) => l?.stop())));
      if (published) await transport.unpublish(sessionId).catch(() => {});
      emit('finished', { status: final, durationS, inputCount, ...(inputDropped ? { inputDropped } : {}), ...(logged ?? (detail ? { detail } : {})) });
      const fallbacks = [!caps.screencast && 'screenshots', !caps.insertText && 'per-key typing'].filter(Boolean).join(', ');
      const shown = detail ?? (fallbacks ? `fallback: ${fallbacks}` : undefined);
      resolveResult({ status: final, sessionId, url, durationS, ...(shown ? { detail: shown } : {}) });
    })();
  }

  /** Waits for `p`, but never longer than STOP_TIMEOUT_MS (a dead browser must not stall the result). */
  async function bounded(p: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([p, new Promise<void>((r) => (timer = setTimeout(r, STOP_TIMEOUT_MS)))]);
    clearTimeout(timer);
  }

  /** Lets go of a mouse button the human still holds, so the agent doesn't get the page back mid-drag. */
  async function releasePressed(): Promise<void> {
    const p = pressed;
    pressed = null;
    if (!p) return;
    const { x, y, button, clickCount } = p;
    await p.target.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, modifiers: 0 }).catch(() => {});
  }

  /**
   * Queues one input from `conn`. Bounded: over MAX_PENDING_INPUT, the oldest pending pointer move or wheel is
   * dropped first; failing that, new input is dropped, except a mouse release, which takes the place of the oldest
   * pending non-release (a dropped release could leave a button held down).
   */
  function enqueueInput(conn: ViewerConnection, input: ViewerInput): void {
    if (isTerminal(status) || conn !== holder()) return void inputDropped++;
    if (pendingInput.length >= MAX_PENDING_INPUT) {
      let i = pendingInput.findIndex((p) => p.input.t === 'wheel' || (p.input.t === 'mouse' && p.input.action === 'move'));
      if (i < 0 && isRelease(input)) i = pendingInput.findIndex((p) => !isRelease(p.input));
      inputDropped++;
      if (i < 0) return; // nothing to make room with: this one is dropped
      pendingInput.splice(i, 1);
    }
    pendingInput.push({ conn, input });
    if (!pumping) void pumpInput();
  }

  async function pumpInput(): Promise<void> {
    pumping = true;
    for (let next = pendingInput.shift(); next; next = pendingInput.shift()) {
      inFlight = dispatchInput(next.conn, next.input);
      await inFlight;
    }
    inFlight = null;
    pumping = false;
  }

  /** Replays one input into the shown page, checking before every CDP call that `conn` may still act on it. */
  async function dispatchInput(conn: ViewerConnection, input: ViewerInput): Promise<void> {
    const live = () => !isTerminal(status) && conn === holder();
    if (!live()) return void inputDropped++;
    const target = active();
    const guarded: Pick<CdpClient, 'send'> = {
      send: (method, params) => (live() ? target.cdp.send(method, params) : Promise.reject(DROPPED)),
    };
    inputCount++;
    try {
      // Shortcuts follow the agent browser's system (Cmd+A from a Mac reaches a Linux browser as Ctrl+A).
      const msgs = input.t === 'key' ? translateShortcut(input, await browserPlatformIsMac(target.cdp)) : [input];
      for (const m of msgs) {
        await applyInput(guarded, m, target.caps);
        if (m.t === 'mouse') trackButton(target, m);
      }
    } catch (e) {
      if (e === DROPPED) return;
      return onTargetError(target, e as Error);
    }
    // After the input has landed, so a tap's new focus and a scroll's new positions are what gets scanned.
    if (live()) fieldFeed.onInput(input);
  }

  function trackButton(target: Target, m: Extract<ViewerInput, { t: 'mouse' }>): void {
    if (m.action === 'down') pressed = { target, x: m.x, y: m.y, button: m.button, clickCount: m.clickCount };
    else if (m.action === 'up') pressed = null;
    else if (pressed) pressed = { ...pressed, x: m.x, y: m.y };
  }

  /** The gate has made `conn` the holder (closing any previous one) and minted its resume key. */
  async function attachViewer(conn: ViewerConnection, vn?: string): Promise<void> {
    resume.attached();
    if (status === 'waiting') go('viewer_joined');
    emit('viewer_joined');
    // credit: 1 — this engine paces frames by the viewer's acks once the viewer opts in ({ t: 'credit', v: 1 }).
    sendJson(conn, { t: 'ready', reason: opts.reason, site: opts.site ?? '', expiresAt, resumeKey: gate.resumeKey()!, ...(vn ? { vn } : {}), credit: 1 });
    if (approvalSession) sendJson(conn, modeFrame());
    if (checking) sendJson(conn, { t: 'state', status });
    sender = holderSender = createLatestSender(conn, { now });
    // The waiting page shows one still of the page, and nothing to type into.
    if (mode === 'approval') return sendPreview();
    // Chrome only sends frames when the page repaints; a static CAPTCHA would leave a new viewer black.
    if (lastFrame) sender.push(lastFrame);
    fieldFeed.onTargetChanged(); // the new viewer needs the current map even if it hasn't changed
    if (!stopScreencast) await startStream();
  }

  /** Approval mode: one still of the shown page to the holder (skipped when the page doesn't answer). */
  async function sendPreview(): Promise<void> {
    let f: Uint8Array;
    try {
      f = await capturePreview(active().cdp);
    } catch {
      return;
    }
    if (mode !== 'approval' || isTerminal(status) || !holder()) return;
    holderSender?.push(f);
    holderSender?.drain();
  }

  /** The person asked to drive the page themselves: from now on this is a normal takeover. */
  async function switchToControl(conn: ViewerConnection): Promise<void> {
    if (mode !== 'approval' || checking || conn !== holder()) return;
    mode = 'control';
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    sendJson(conn, modeFrame());
    fieldFeed.onTargetChanged();
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
    if (gen !== streamGen || holder() === null || isTerminal(status)) return void stop().catch(() => {});
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
    if (!holder() || isTerminal(status) || mode === 'approval') return;
    await stopStream();
    lastFrame = null;
    if (!holder() || isTerminal(status)) return;
    holderSender?.clear();
    sender = holderSender;
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
    // Locked to the takeover's sites only (the page's site and the listed ones), never the site it opened on. A popup
    // already elsewhere (e.g. a target=_blank link to another site) is closed, and a popup that can't be locked is
    // never shown to the human.
    const lock = await lockPage(popup, { allowedSites: pageSites, ownSite: false, onBlocked }).catch(() => null);
    if (lock && !lock.onAllowedPage) {
      onBlocked(await popup.send<{ frameTree: { frame: { url: string } } }>('Page.getFrameTree').then((t) => t.frameTree.frame.url, () => ''));
      void popup.send('Page.close').catch(() => {});
    }
    if (!lock || !lock.onAllowedPage || gone || isTerminal(status)) {
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

  /** The gate has already cleared the holder and started the resume window. */
  function detachViewer(): void {
    go('viewer_left');
    emit('viewer_left');
    void stopStream();
    resume.left();
  }

  function handleInput(conn: ViewerConnection, msg: ViewerToEngine): void {
    // approved and switch_control belong to approval sessions, answer to question sessions.
    // (The gate answers an unparsable message or a second hello itself; hello is listed here for the type.)
    if (msg.t === 'hello' || msg.t === 'answer' || (!approvalSession && (msg.t === 'approved' || msg.t === 'switch_control'))) return gate.reject(conn, 'bad_message', false);
    switch (msg.t) {
      case 'approved':
        // The person's word only: the page must show the sign-in went through.
        return void judgeApproval('approved_by_person');
      case 'switch_control':
        return void switchToControl(conn);
      case 'ping':
        return sendJson(conn, { t: 'pong' });
      case 'credit':
        return void (conn === holder() && holderSender?.enableCredit());
      case 'ack':
        return void (conn === holder() && holderSender?.ack(msg.seq));
      case 'done':
        return finish('resolved');
      case 'cant_solve': {
        // Typed by the human and handed to the agent (often an AI): one clean line, and never written to the log.
        const reason = cleanReason(msg.reason ?? '');
        return finish('cancelled', reason || 'cant_solve', reason ? { detail: 'cant_solve', reasonLength: reason.length } : undefined);
      }
      default: {
        if (mode === 'approval') return; // the waiting page takes no input
        const safe = safeInput(msg);
        if (safe) enqueueInput(conn, safe);
      }
    }
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
      // The takeover may have ended while locking: then finish() didn't see this lock, so release it here.
      if (isTerminal(status)) return void lock.stop();
      pageSites = lock.sites;
      targets.push({ cdp, caps, off: () => {}, lock });
      if (approvalSession) offNavigated = cdp.on('Page.frameNavigated', onNavigated);
    } catch {
      return finish('failed', 'page_lock_unavailable'); // never hand out a page that isn't locked
    }
    if (opts.popups) offPopups = opts.popups.onPopup((popup) => void addPopup(popup));
    const link = await publishLink({
      transport,
      key,
      sessionId,
      expiresAt,
      mode: opts.mode ?? 'control',
      gate,
      isEnded: () => isTerminal(status),
      onPublished: () => (published = true),
      onStatus: resume.onStatus,
    });
    if ('failed' in link) return finish('failed', link.failed);
    if (!('url' in link)) return;
    url = link.url;
    go('published');
    emit('published');
    // Notifications are Unstuck Cloud alerts sent by the engine from onLink (sealed to paired phones); see the notifications
    // design, section 4.2 (docs/specs/2026-11-14-notifications-design.md in the unstuck-cloud repo). "notifying" completes immediately.
    go('notified');
    emit('link', { expiresAt });
    if (approvalSession && opts.approvalSince !== undefined) {
      // Ends the takeover by itself once the prompt has gone; never rejects but for the abort in finish().
      watchApproval(cdp, { since: opts.approvalSince, signal: watch.signal }).then(
        (v) => judgeApproval(v === 'navigated' ? 'approval_navigated' : 'approval_changed'),
        () => {},
      );
    }
    try {
      const info: LinkInfo = { sessionId, url, reason: opts.reason, expiresAt, ...(code !== undefined ? { code } : {}), ...(opts.kind ? { kind: opts.kind } : {}), mode: opts.mode ?? 'control' };
      opts.onLink?.(info, { fail, cancel, joined: gate.joined, ended: result });
    } catch {
      // A link handler that throws is the caller's bug: the takeover keeps running (an alert may already be on its way).
    }
    // Never an unhandled rejection (it would crash Node, and the takeover would wait for its timeout): fail it now.
  })().catch((e: unknown) => finish('failed', `internal_error: ${(e as Error)?.message ?? String(e)}`));

  function fail(detail: string): void {
    finish('failed', detail);
  }
  /**
   * Approval mode: the prompt went away or the person says they approved. The person sees "Checking the page…" (a
   * `state` frame of the running session) while the page is judged; the session is `resolved` (with `passed` as its
   * detail) only on positive evidence, otherwise `failed` with `still_blocked:<detail>` (see checkApproval).
   */
  async function judgeApproval(passed: string): Promise<void> {
    if (checking || isTerminal(status)) return;
    checking = true;
    const h = holder();
    if (h) sendJson(h, { t: 'state', status });
    const verdict = await checkApproval(cdp, { signal: watch.signal }).catch(() => 'approval_unreadable');
    if (verdict === null) finish('resolved', passed);
    else finish('failed', STILL_BLOCKED_PREFIX + verdict);
  }
  function cancel(detail: string): void {
    finish('cancelled', detail);
  }
  /** Approval mode: a main-frame navigation retakes the preview, once the page has stopped navigating for a moment. */
  function onNavigated(e: { frame?: { parentId?: string } }): void {
    if (e.frame?.parentId || mode !== 'approval') return;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      if (holder()) void sendPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  return { result, ended: result, cancel, fail, joined: gate.joined };
}

/** One JPEG of the page as an encoded type-1 frame, like the screenshot fallback stream (stream/poll.ts). */
async function capturePreview(cdp: CdpClient): Promise<Uint8Array> {
  const metrics = await within(
    cdp.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics'),
    CAPTURE_TIMEOUT_MS,
    'Page.getLayoutMetrics',
  );
  const shot = await within(cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: PREVIEW_QUALITY }), CAPTURE_TIMEOUT_MS, 'Page.captureScreenshot');
  const bin = atob(shot.data);
  return encodeFrame({
    width: Math.round(metrics.cssVisualViewport.clientWidth),
    height: Math.round(metrics.cssVisualViewport.clientHeight),
    jpeg: Uint8Array.from(bin, (c) => c.charCodeAt(0)),
  });
}

function isRelease(m: ViewerInput): boolean {
  return m.t === 'mouse' && m.action === 'up';
}

/** Uniform 000000–999999 from the CSPRNG (rejection sampling avoids modulo bias). */
export function newCode(): string {
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= 4_294_000_000);
  return String(buf[0]! % 1_000_000).padStart(6, '0');
}

/** The human's "Can't solve" text as one plain line: no control, format or bidi characters, spaces collapsed. */
export function cleanReason(text: string): string {
  return cleanLine(text, 200);
}

/** Text a person typed for the agent as one plain line of at most `max` characters (the rules of cleanReason). */
export function cleanLine(text: string, max: number): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
