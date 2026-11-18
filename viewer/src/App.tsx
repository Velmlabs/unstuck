import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import type { AskAnswer, EngineToViewer, Field, FieldKind, Frame, SessionStatus, ViewerErrorCode, ViewerToEngine } from '@velmlabs/unstuck-protocol';
import { connect as defaultConnect, e2eCodec, type Codec, type ConnectionHandlers, type Phase, type ViewerSocket } from './connection';
import { importE2eKey } from '@velmlabs/unstuck-protocol';
import { drawFrameOnCanvas } from './draw';
import { attachBridge, configureBridge } from './bridge';
import { bridgeBox, clipBox, fieldBox, hitField, keepInside, liftOffset, type Box } from './fields';
import { keyEventToMessage, modifiersOf } from './keys';
import { FIT_VIEW, MAX_ZOOM, NO_INSET, clampToPage, clampView, imageRect, isFit, pinchView, sizeChangedALot, toPagePoint, viewTransform, visiblePageRect, zoomAt, type Inset, type Pinch, type Point, type Rect, type View } from './mapping';
import { forgetFragment, modeHint, parseFragment, relayFor, sessionIdFromPath } from './url';
import { cleanLabel, type Sender, type StartMode } from './alert-link';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, DragIcon, FitIcon, FlagIcon, HelpIcon, KeyboardIcon, ZoomInIcon, ZoomOutIcon } from './icons';
import { HelpSheet } from './help';
import { TipButton, useFirstTimeHint, useTips } from './tips';
import { ApprovalScreen } from './ApprovalScreen';
import { QuestionScreen } from './QuestionScreen';

export interface AppProps {
  location: { hash: string; pathname: string; origin: string; search?: string };
  connectFn?: (url: string, token: string, codec: Codec, h: ConnectionHandlers, opts: { resumeKey?: string; alive?: () => Promise<boolean> }) => ViewerSocket;
  /** Draws `frame`; calls `onDrawn` once it is on the canvas (frame credit acks). */
  drawFrame?: (canvas: HTMLCanvasElement, frame: Frame, onDrawn: (f: Frame) => void) => void;
  now?: () => number;
  /** A sealed link this browser could not open: show the "phone you paired" page and never connect. */
  alertError?: 'no_device' | 'not_for_this_device';
  /**
   * What a sealed link said (shown before the relay's own answer arrives). `sender` asks Cloud whether it really sent
   * this alert to this phone: only then is the key named.
   */
  alert?: { reason: string; site: string; mode?: StartMode; question?: string; sender?: () => Promise<Sender> };
}

/** The start page of a question or an approval (a takeover's says "Start takeover"). */
const START_COPY: Record<StartMode, { title: string; lede: string; button: string }> = {
  question: { title: 'Your agent has a question', lede: 'Tap Answer to see it and reply.', button: 'Answer' },
  approval: { title: 'Approve a sign-in', lede: 'Tap Open to see what to approve on your phone.', button: 'Open' },
};

type Screen =
  | { kind: 'session' }
  | { kind: 'message'; title: string; body: string; tone: 'ok' | 'warn' | 'error' };

const ERROR_SCREENS: Record<Exclude<ViewerErrorCode, 'bad_message' | 'code_required' | 'code_invalid'>, Screen> = {
  token_invalid: { kind: 'message', title: 'This link is not valid', body: 'Ask for a new link from the person or agent that sent it.', tone: 'error' },
  token_used: { kind: 'message', title: 'This link is already in use', body: 'Someone else opened this takeover first. Only one person can control the browser at a time.', tone: 'warn' },
  expired: { kind: 'message', title: 'This link has expired', body: 'The takeover window closed before anyone joined.', tone: 'warn' },
  session_closed: { kind: 'message', title: 'This takeover has ended', body: 'You can close this tab.', tone: 'ok' },
};

const PAIRED_PHONE_SCREEN: Screen = {
  kind: 'message',
  title: 'Open this link on the phone you paired',
  body: 'This link was sealed for your paired phone and can only be opened there. Using Telegram? Its in-app browser has no access to the pairing: in Telegram, go to Settings → Chat Settings, turn off "In-App Browser", then tap the link again.',
  tone: 'warn',
};

const REPAIRED_SCREEN: Screen = {
  kind: 'message',
  title: "This link can't be opened here",
  body: "This phone was paired again or removed, so alerts sent before that can't be opened here.",
  tone: 'warn',
};

const NOT_SENT = "This link wasn't sent by Unstuck alerts. Only continue if you expected it.";

const INCOMPLETE_SCREEN: Screen = {
  kind: 'message',
  title: 'Link incomplete',
  body: 'This link is incomplete. Copy the whole link and open it again.',
  tone: 'error',
};

/** Seals with the key from the link; the key is imported once, lazily, so connecting stays synchronous. */
function lazyCodec(raw: Uint8Array, sessionId: string): Codec {
  const codec = importE2eKey(raw).then((k) => e2eCodec(k, sessionId));
  return { seal: async (conn, seq, p) => (await codec).seal(conn, seq, p), open: async (conn, b) => (await codec).open(conn, b) };
}

const FINAL_SCREENS: Partial<Record<SessionStatus, Screen>> = {
  resolved: { kind: 'message', title: 'All done, thank you', body: 'Control is back with the agent. You can close this tab.', tone: 'ok' },
  cancelled: { kind: 'message', title: 'Handed back to the agent', body: 'The agent knows this one could not be solved. You can close this tab.', tone: 'warn' },
  timed_out: { kind: 'message', title: 'Time ran out', body: 'The takeover window closed. The agent will decide what to do next.', tone: 'warn' },
  failed: { kind: 'message', title: 'The page closed or something went wrong', body: 'The agent will be told. You can close this tab.', tone: 'error' },
};

const APPROVED_SCREEN: Screen = { kind: 'message', title: 'Approved, thank you', body: 'The sign-in went through and your agent carried on. You can close this tab.', tone: 'ok' };
/** An approval session that ended `failed`: the engine found no proof on the page that the sign-in went through. */
const NOT_APPROVED_SCREEN: Screen = { kind: 'message', title: "The sign-in didn't go through", body: 'Your agent will try again or ask you. You can close this tab.', tone: 'warn' };

/** The viewer's own controls: keys pressed on them are not sent to the agent's page. */
const CHROME = 'button, .topbar, .bottombar, .stage-controls, .sheet';
const BUTTONS: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' };
const SCROLL_FRACTION = 0.6;

/** Resume keys survive a reload or a re-opened link on the same device (localStorage is per origin). */
const resumeStore = {
  key: (sessionId: string) => `unstuck:resume:${sessionId}`,
  get(sessionId: string): string | undefined {
    try {
      return localStorage.getItem(this.key(sessionId)) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(sessionId: string, value: string | null): void {
    // The takeover is over: the link's secret kept for reloads in this tab goes too.
    if (value === null) {
      try {
        forgetFragment(sessionId, sessionStorage);
      } catch {
        // sessionStorage itself blocked
      }
    }
    try {
      if (value === null) localStorage.removeItem(this.key(sessionId));
      else localStorage.setItem(this.key(sessionId), value);
    } catch {
      // storage unavailable (private mode): resume still works within this page load
    }
  },
};

/** How long the viewer waits for the page's first picture before saying it may still be loading. */
const FIRST_FRAME_HINT_MS = 10_000;

/** A press that moves less than this (CSS px) before release is a tap, not a drag. */
const TAP_SLOP_PX = 10;

/*
 * Touch gestures on the mirror (a mouse or pen is sent as it comes, press on press):
 * - One finger is held back until it means something, so a second finger can still turn it into a pinch without the
 *   page ever seeing a click:
 *   - a tap (released within TAP_SLOP_PX): the press is sent at release, and the release follows after as long as the
 *     finger was really down (TAP_MIN_MS..TAP_MAX_MS), at the press point, so the page sees a real tap's duration;
 *   - a swipe (moved past the slop before HOLD_MS): a move, like a map. Nothing reaches the page as mouse input, so a
 *     swipe never clicks. Zoomed in, the finger first pans the view (clamped like a pinch's pan); whatever the view
 *     can't take (at fit, or at its edge) scrolls the agent's page: a wheel at the page point where the finger landed
 *     (kept for the whole swipe, as a touch scroll latches onto what it started on), in page px through the current
 *     scale, the content following the finger (finger up, page down). A swipe that starts mostly vertical (or
 *     horizontal) scrolls only that axis, so a wobble never hands the scroll to a sideways scroller (a carousel); a
 *     diagonal one scrolls both. At most one wheel per MOVE_MS: the movement in between adds up and goes with the next
 *     one, and what is left goes at the lift (a cancel drops it);
 *   - a hold (still for HOLD_MS): the press is sent then (press-and-hold challenges), with a short buzz and a ring
 *     under the finger, and if the finger then moves it is a mouse drag: moves as they come (one per MOVE_MS, the
 *     newest held back sent when the tick ends), the release where it lifts. So press and hold, then drag: a slider
 *     or a puzzle piece;
 *   - in Drag mode (the rail's toggle, for long drag puzzles) a swipe is a mouse drag at once instead: the press where
 *     the finger landed, then a move where it crossed the slop one throttle tick later, then moves as they come.
 * - Two fingers pinch to zoom around their midpoint and pan as the midpoint moves. A second finger after a press was
 *   sent ends that press (a release where the first finger is) before the pinch starts. Nothing reaches the page;
 *   a finger left over after a pinch, or a third finger, does nothing until it lifts.
 * - No double-tap zoom: two quick taps are two clicks (a re-tap on a slow stream, two neighbouring tiles).
 * - A new first finger (isPrimary: no other finger is down) starts from a clean state, in case a lift was never
 *   reported; so do a lost pointer capture, the page being hidden and the session leaving live.
 */
const HOLD_MS = 350;
/** How long the ring under a finger shows when a hold engages. */
const HOLD_RING_MS = 300;
const TAP_MIN_MS = 40;
const TAP_MAX_MS = 250;
const MOVE_MS = 16;
/** The Drag mode toggle's tooltip, for each state (it says what a swipe does now). */
export const DRAG_TIP_ON = 'Drag mode: on. Swipes drag on the page.';
export const DRAG_TIP_OFF = 'Drag mode: off. Swipe to move, hold to drag.';
const ZOOM_ANIM_MS = 180;
const reducedMotion = () =>
  typeof window.matchMedia !== 'function' || typeof requestAnimationFrame !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The next zoom button step from `scale`, on the √2 ladder: fit, 1.4×, 2×, 2.8×, 4× (a pinch can leave the zoom between steps). */
const zoomStep = (scale: number, dir: 1 | -1) => {
  const level = Math.log2(scale) * 2;
  return 2 ** ((dir > 0 ? Math.floor(level + 1e-6) + 1 : Math.ceil(level - 1e-6) - 1) / 2);
};
const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);
const pinchOf = (a: Point, b: Point): Pinch => ({ mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) });

/** "From your key <name> · <site>", both as plain text without control, zero-width or bidi characters. */
function fromLine(keyName: string, sealedSite: string): string {
  const site = cleanLabel(sealedSite, 253);
  return `From your key ${cleanLabel(keyName)}${site ? ` · ${site}` : ''}`;
}

/** `Unstuck · live` in control, `Unstuck · handed back` once the person finished it, `Unstuck · ended` for any other end. */
export function viewerTitle(session: boolean, phase: Phase, handedBack: boolean): string {
  if (handedBack) return 'Unstuck · handed back';
  if (!session || phase === 'ended' || phase === 'closed') return 'Unstuck · ended';
  return phase === 'live' ? 'Unstuck · live' : 'Unstuck';
}

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function App({ location, connectFn = defaultConnect, drawFrame = drawFrameOnCanvas, now = Date.now, alertError, alert }: AppProps) {
  const fragment = alertError ? null : parseFragment(location.hash);
  const link = fragment && 'token' in fragment ? fragment : null;
  // The key is named only when Cloud confirms it delivered this alert to this phone (never from the link's ?by=).
  const [sender, setSender] = useState<Sender>(null);
  const token = link?.token;
  const sessionId = sessionIdFromPath(location.pathname);
  const [screen, setScreen] = useState<Screen>(
    alertError === 'not_for_this_device' ? REPAIRED_SCREEN : alertError ? PAIRED_PHONE_SCREEN : token && sessionId ? { kind: 'session' } : fragment && 'error' in fragment ? INCOMPLETE_SCREEN : ERROR_SCREENS.token_invalid,
  );
  /**
   * Nothing connects until a person taps Start: a link preview or an email scanner that opens the page in a real
   * browser never takes the link, never sees the screen and is never charged. The phone that already started this
   * takeover (it holds the resume key) goes straight back in.
   */
  // ?embed=1: the inbox's own frame, opened by the person's tap on Answer, so there is nothing to wait for.
  const [started, setStarted] = useState(() => new URLSearchParams(location.search ?? '').get('embed') === '1' || !!(sessionId && resumeStore.get(sessionId)));
  /** What the start page says: from the sealed payload, else the plain link's `&m=` hint; null for a takeover. */
  const startMode = alert?.mode ?? modeHint(location.hash);
  const [codeAsk, setCodeAsk] = useState<{ invalid: boolean } | null>(null);
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('connecting');
  const [info, setInfo] = useState<{ reason: string; site: string; expiresAt: number } | null>(null);
  const [remaining, setRemaining] = useState('');
  const [asking, setAsking] = useState(false);
  /** The help sheet is open: the mirror takes no input until it closes (the session carries on). */
  const [helping, setHelping] = useState(false);
  const helpButton = useRef<HTMLButtonElement | null>(null);
  const helpingRef = useRef(false);
  helpingRef.current = helping;
  /** Keys pressed while Help was open (the Esc or Enter that closed it): their keyups never reach the page either. */
  const helpKeys = useRef(new Set<string>());
  /** Focus goes back to Help once the sheet is gone and the viewer is no longer inert. */
  const refocusHelp = useRef(false);
  /** What a screen reader announces when Drag mode changes. */
  const [announce, setAnnounce] = useState('');
  /** The ring under the finger when a hold engages (stage px), and its timer. */
  const [holdRing, setHoldRing] = useState<{ x: number; y: number; n: number } | null>(null);
  const holdRingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Drag mode: a one-finger swipe drags on the page at once. Off for every new takeover (never stored). */
  const [dragMode, setDragMode] = useState(false);
  const dragModeRef = useRef(false);
  dragModeRef.current = dragMode;
  const [reason, setReason] = useState('');
  /** Approval and question sessions: the last mode frame (an older engine never sends one: the live view stays). */
  const [modeFrame, setModeFrame] = useState<Extract<EngineToViewer, { t: 'mode' }> | null>(null);
  const modeRef = useRef(modeFrame);
  modeRef.current = modeFrame;
  const [errors, setErrors] = useState(0);
  const [answered, setAnswered] = useState<AskAnswer | null>(null);
  /** The engine sent the session's result: what the socket reports after that (closed, ended, an error) changes nothing. */
  const finished = useRef(false);
  /** Approval mode: the engine is checking the page before it ends the session. */
  const [approvalChecking, setApprovalChecking] = useState(false);
  const approvalCanvas = useRef<HTMLCanvasElement>(null);
  /** A frame that came in before the preview canvas was on the page. */
  const previewWait = useRef<{ f: Frame; drawn: (f: Frame) => void } | null>(null);
  /** Gives a held frame's credit back without drawing it (the frame is no longer wanted). */
  const dropPreview = () => {
    const w = previewWait.current;
    previewWait.current = null;
    w?.drawn(w.f);
  };
  useEffect(() => () => dropPreview(), []);
  useEffect(() => {
    const w = previewWait.current;
    if (w && approvalCanvas.current) {
      previewWait.current = null;
      drawFrame(approvalCanvas.current, w.f, w.drawn);
    }
  }, [modeFrame]);
  const embed = new URLSearchParams(location.search ?? '').get('embed') === '1';
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bridgeRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /** Native typing: the engine's field map, the field under the current press, and where the bridge sits. */
  const fieldsRef = useRef<Field[]>([]);
  const tapRef = useRef<{ x: number; y: number; field: Field | null } | null>(null);
  const bridgeKind = useRef<FieldKind>('text');
  const bridgeBoxRef = useRef<Box | null>(null);
  const mappedTap = useRef(false);
  /** Taps sent whose focus report hasn't arrived yet: only the newest tap's report may open or close anything. */
  const awaitingFocus = useRef(0);
  const [chip, setChip] = useState<FieldKind | null>(null);
  /** The phone keyboard is open (the bridge has focus): the Keyboard button shows as switched on (data-active). */
  const [typing, setTyping] = useState(false);
  /** The green outline around the field being typed into (Unstuck's own layer, never the page). */
  const [ring, setRing] = useState<Box | null>(null);
  /** The field the outline and typing box sit over, so they can be placed again when the mirror's area resizes. */
  const ringField = useRef<Field | null>(null);
  const sockRef = useRef<ViewerSocket | null>(null);
  const pageSize = useRef({ width: 0, height: 0 });
  /** Zoom and pan of the mirror (see mapping.ts); the viewport is the untransformed box the canvas is zoomed in. */
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View>(FIT_VIEW);
  const [zoomed, setZoomed] = useState<'fit' | 'zoomed' | 'max'>('fit');
  const anim = useRef<{ id: number; target: View } | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  /**
   * Touch pointers down on the mirror; a finger held back (see the gesture rules above); the finger whose press was
   * sent, and where it is; a pinch; a tap's release on its way.
   */
  const touches = useRef(new Map<number, Point>());
  const held = useRef<{ id: number; x: number; y: number; p: Point | null; downAt: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const pressTouch = useRef<{ id: number; x: number; y: number } | null>(null);
  const pinch = useRef<{ ids: [number, number]; from: Pinch; start: View } | null>(null);
  const pendingUp = useRef<{ p: Point; button: 'left' | 'middle' | 'right'; timer: ReturnType<typeof setTimeout> } | null>(null);
  /**
   * A swipe: the finger, where it was last seen (client px) and its page point; the scroll not sent yet (page px) and
   * the wheel throttle's tick.
   */
  const swipe = useRef<{ id: number; x: number; y: number; p: Point | null; axis: 'x' | 'y' | 'free' } | null>(null);
  const wheelDue = useRef({ dx: 0, dy: 0 });
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The newest move held back by the throttle: sent when the tick ends, so a drag always ends where the finger is. */
  const trailingMove = useRef<Extract<ViewerToEngine, { t: 'mouse' }> | null>(null);
  /** Where the page last saw the pointer move (a release elsewhere first gets a move there). */
  const lastMove = useRef<Point | null>(null);
  /** Nothing drawn yet: the black area says it is waiting for the page, not broken. */
  const [framed, setFramed] = useState(false);
  const framedRef = useRef(false);
  const [slowFirstFrame, setSlowFirstFrame] = useState(false);
  const moveQueued = useRef(false);
  const pressed = useRef<'left' | 'middle' | 'right' | null>(null);
  const site = info?.site || alert?.site || '';
  const live = screen.kind === 'session' && phase === 'live';
  // The session's state in the title, for the Android app's WebView (it watches the title: no JS bridge).
  useEffect(() => {
    document.title = viewerTitle(screen.kind === 'session', phase, finished.current || answered !== null);
  }, [screen, phase, answered]);
  const liveRef = useRef(live);
  liveRef.current = live && !asking && !helping;
  const tips = useTips();
  const hint = useFirstTimeHint(live);

  const send = useCallback((m: ViewerToEngine) => {
    // A tap's release still on its way goes before anything else (a key, typed text, Done): the page sees the tap end
    // before what follows it.
    if (m.t !== 'mouse' && pendingUp.current) flushUp();
    // The engine answers each tap and each typed key with a focus report: count them, so only the newest report acts.
    if ((m.t === 'mouse' && m.action === 'up') || (m.t === 'key' && m.action === 'down') || m.t === 'text') awaitingFocus.current++;
    sockRef.current?.send(m);
  }, []);

  useEffect(() => {
    if (!started || !link || !token || !sessionId) return;
    const saved = resumeStore.get(sessionId);
    // The relay serves this page, or (viewer on its own origin) is named in ?r=.
    const relay = relayFor(location.search ?? '', location.origin);
    const own = relay.http === location.origin;
    const sock = connectFn(`${relay.ws}/ws/${sessionId}`, token, lazyCodec(link.key, sessionId), {
      onCodeRequest: (invalid) => setCodeAsk({ invalid }),
      onFields: (fields) => void (fieldsRef.current = fields),
      onFocus: (kind, field) => {
        awaitingFocus.current = Math.max(0, awaitingFocus.current - 1);
        if (awaitingFocus.current > 0) return; // a report for an earlier input: a newer one is on its way
        const typing = document.activeElement === bridgeRef.current;
        if (kind === null) {
          setChip(null);
          // The map said "field" but the page didn't take focus there: no keyboard over a non-field.
          if (typing && mappedTap.current) closeBridge();
        } else if (!typing) setChip(kind);
        else if (field) placeOver(field); // the page moved focus (e.g. to a code widget's next box): follow it
      },
      onReady: (r) => {
        setCodeAsk(null);
        resumeStore.set(sessionId, r.resumeKey);
        setInfo({ reason: r.reason, site: r.site, expiresAt: r.expiresAt });
      },
      onFrame: (f) => {
        const before = pageSize.current;
        pageSize.current = { width: f.width, height: f.height };
        // Another page or a popup: back to fit. The same page a little different (a scrollbar): keep the zoom, in range.
        if (before.width !== f.width || before.height !== f.height) {
          if (sizeChangedALot(before, pageSize.current)) setView(FIT_VIEW);
          else if (!isFit(viewRef.current) && viewportRef.current) setView(clampView(viewRef.current, mirrorBox(), pageSize.current, controlsInset()));
        }
        // Frame credit: the engine sends the next frame once this one is on screen (a slow phone never builds a backlog).
        const drawn = (d: Frame) => sockRef.current?.ack(d);
        const target = modeRef.current?.mode === 'approval' ? approvalCanvas.current : modeRef.current?.mode === 'question' ? null : canvasRef.current;
        dropPreview(); // a held preview frame is replaced: it still gets its credit back
        if (target) drawFrame(target, f, drawn);
        else if (modeRef.current?.mode === 'approval') previewWait.current = { f, drawn }; // drawn once the preview mounts
        else drawn(f);
        if (target !== null && target === canvasRef.current && !framedRef.current) {
          framedRef.current = true;
          setFramed(true);
        }
      },
      onMode: (m) => {
        if (m.mode !== 'approval') dropPreview();
        modeRef.current = m; // a frame right behind it (same tick) must already go to the right canvas
        setModeFrame(m);
      },
      onState: (s, answer) => {
        const approving = modeRef.current?.mode === 'approval';
        // A running approval session says it is judging the page (the prompt went away, or the person tapped).
        if (s === 'active' && approving) return setApprovalChecking(true);
        const final = approving && s === 'resolved' ? APPROVED_SCREEN : approving && s === 'failed' ? NOT_APPROVED_SCREEN : FINAL_SCREENS[s];
        if (s === 'answered') setAnswered(answer ?? {});
        if (final || s === 'answered') {
          finished.current = true;
          resumeStore.set(sessionId, null);
          if (final) setScreen(final);
          sockRef.current?.close();
        }
      },
      onError: (code) => {
        if (finished.current) return;
        setErrors((n) => n + 1);
        // An error that ends this link for good: the secret kept for reloads goes with it.
        if (code === 'token_used' || code === 'expired' || code === 'session_closed' || code === 'token_invalid') resumeStore.set(sessionId, null);
        if (code in ERROR_SCREENS) setScreen(ERROR_SCREENS[code as keyof typeof ERROR_SCREENS]);
      },
      onPhase: (p) => {
        if (finished.current) return;
        setPhase(p);
        if (p === 'closed')
          setScreen({ kind: 'message', title: 'Connection lost', body: 'Reopen the link on this device within 5 minutes to continue where you left off.', tone: 'error' });
        if (p === 'ended') {
          resumeStore.set(sessionId, null);
          setScreen({ kind: 'message', title: 'This check has ended', body: 'The agent is no longer waiting for this check. If it still needs you, it will send a new link.', tone: 'error' });
        }
      },
    }, {
      ...(saved ? { resumeKey: saved } : {}),
      // The relay answers 404 for a session that has ended (its page shows "expired").
      alive: () =>
        fetch(own ? `${location.origin}${location.pathname}` : `${relay.http}/s/${sessionId}`, { method: 'HEAD', cache: 'no-store' }).then((r) => r.status !== 404, () => true),
    });
    sockRef.current = sock;
    // Back from another app (iOS froze the page and its retry timers), or back online: reconnect now.
    const wake = () => {
      if (document.visibilityState !== 'hidden') sock.wake();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      sock.close();
    };
  }, [started]);

  useEffect(() => {
    alert?.sender?.().then(setSender, () => setSender(null));
  }, []);

  const waitingForFrame = live && !framed;
  useEffect(() => {
    if (!waitingForFrame) return;
    const id = setTimeout(() => setSlowFirstFrame(true), FIRST_FRAME_HINT_MS);
    return () => clearTimeout(id);
  }, [waitingForFrame]);

  useEffect(() => {
    if (!info) return;
    const tick = () => setRemaining(formatRemaining(info.expiresAt - now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [info]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const code = e.code || e.key;
      // The keyup of a key pressed while Help was open (the Esc or Enter that closed it) stays with the viewer.
      if (e.type === 'keyup' && helpKeys.current.delete(code)) return;
      if (helpingRef.current) {
        if (e.type === 'keydown') helpKeys.current.add(code);
        return;
      }
      if (!liveRef.current || e.target === bridgeRef.current) return;
      // A key on the viewer's own controls (Enter or Space on a button, Tab between them) is theirs, not the page's.
      if (e.target instanceof Element && e.target.closest(CHROME)) return;
      const m = keyEventToMessage(e);
      if (!m) return;
      e.preventDefault();
      send(m);
    };
    const onPaste = (e: Event) => {
      if (!liveRef.current || e.target === bridgeRef.current) return; // the bridge sends its own pastes
      const text = (e as ClipboardEvent).clipboardData?.getData('text/plain');
      if (text) {
        e.preventDefault();
        send({ t: 'text', text });
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [send]);

  /** Opens the phone keyboard for a kind of field, with the bridge over the field (or the mirror's bottom strip). */
  const openBridge = (kind: FieldKind, field: Field | null) => {
    const el = bridgeRef.current;
    const c = canvasRef.current;
    const stage = stageRef.current;
    if (!el || !c || !stage) return;
    const box = boxOver(field);
    configureBridge(el, kind);
    bridgeKind.current = kind;
    bridgeBoxRef.current = field ? box : null; // only a tapped field is kept in view above the keyboard
    mappedTap.current = field !== null;
    Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    el.focus({ preventScroll: true }); // inside the tap's own handler, or iOS won't open the keyboard
    setChip(null);
    ringField.current = field;
    showRing(field ? ringOver(field) : null);
    relift(); // the keyboard may already be open (another field was being typed into)
  };
  /** Where a field (or, for null, the mirror's bottom strip) sits over the mirror, in CSS px of the stage. */
  const canvasRect = () => {
    const cr = viewportRef.current!.getBoundingClientRect();
    const sr = stageRef.current!.getBoundingClientRect();
    return { left: cr.left - sr.left, top: cr.top - sr.top, width: cr.width, height: cr.height };
  };
  /** Zoomed, a field can be partly or wholly panned off the mirror: the typing box stays on it, never over the bars. */
  const boxOver = (field: Field | null): Box => {
    const area = canvasRect();
    return keepInside(bridgeBox(field, area, pageSize.current, viewRef.current), area);
  };
  /** The outline: the field's exact box, with no minimum size, cut to the mirror (none when the field is off it). */
  const ringOver = (field: Field): Box | null => clipBox(fieldBox(field, canvasRect(), pageSize.current, viewRef.current), canvasRect());
  const showRing = (box: Box | null) => setRing((prev) => (sameBox(prev, box) ? prev : box));
  /** Moves the outline and the typing box over the field the page now focuses, keeping the keyboard open. */
  const placeOver = (field: Field) => {
    const el = bridgeRef.current;
    if (!el || !canvasRef.current || !stageRef.current) return;
    const box = boxOver(field);
    Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    bridgeBoxRef.current = box;
    ringField.current = field;
    showRing(ringOver(field));
    relift();
  };
  /** Lifts the mirror so the tapped field sits above the keyboard (the visual viewport), or drops the lift. */
  const relift = () => {
    const vv = window.visualViewport;
    const stage = stageRef.current;
    const box = bridgeBoxRef.current;
    if (!vv || !stage) return;
    if (document.activeElement !== bridgeRef.current || !box) return void (stage.style.transform = '');
    const current = Number.parseFloat(stage.style.transform.slice('translateY('.length)) || 0;
    const lift = liftOffset(box, (vv.offsetTop || 0) + vv.height, stage.getBoundingClientRect().top - current);
    stage.style.transform = lift ? `translateY(-${lift}px)` : '';
  };
  const closeBridge = () => {
    bridgeRef.current?.blur();
    mappedTap.current = false;
    if (stageRef.current) stageRef.current.style.transform = '';
  };

  /** The mirror's untransformed box in client px: every client↔page conversion is relative to it (mapping.ts). */
  const mirrorBox = (): Rect => {
    const r = viewportRef.current!.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  /** The corner the zoom and scroll buttons cover: zoomed, the page may pan out from under it. */
  const controlsInset = (): Inset => {
    const c = controlsRef.current?.getBoundingClientRect();
    if (!c || !c.width || !viewportRef.current) return NO_INSET;
    const b = mirrorBox();
    return { right: Math.max(0, b.left + b.width - c.left), bottom: Math.max(0, b.top + b.height - c.top) };
  };
  const point = (e: { clientX: number; clientY: number }) =>
    viewportRef.current ? toPagePoint({ x: e.clientX, y: e.clientY }, mirrorBox(), pageSize.current, viewRef.current) : null;

  /** Shows the mirror at a zoom and pan, and keeps the outline and the typing box over their field. */
  const setView = (v: View) => {
    viewRef.current = v;
    if (canvasRef.current) canvasRef.current.style.transform = viewTransform(v);
    setZoomed(isFit(v) ? 'fit' : v.scale >= MAX_ZOOM ? 'max' : 'zoomed');
    const field = ringField.current;
    if (field && canvasRef.current && stageRef.current) placeOver(field);
  };
  const stopZoomAnimation = () => {
    if (!anim.current) return;
    cancelAnimationFrame(anim.current.id);
    anim.current = null;
  };
  /**
   * Zooms to a view: eased over ZOOM_ANIM_MS, or at once for people who prefer reduced motion. Each animation frame
   * sets the real view, so a tap mid-animation still maps to what is on screen.
   */
  const animateTo = (target: View) => {
    stopZoomAnimation();
    if (reducedMotion()) return setView(target);
    const from = viewRef.current;
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / ZOOM_ANIM_MS);
      const e = 1 - (1 - t) ** 3;
      const mix = (a: number, b: number) => a + (b - a) * e;
      // Scale and pan move together linearly in e, so the zoom's focal point stays put all the way.
      setView(t >= 1 ? target : { scale: mix(from.scale, target.scale), x: mix(from.x, target.x), y: mix(from.y, target.y) });
      anim.current = t >= 1 ? null : { id: requestAnimationFrame(step), target };
    };
    anim.current = { id: requestAnimationFrame(step), target };
  };
  /** The zoom buttons: one √2 step around the mirror's centre (a second press mid-animation builds on its target). */
  const zoomButton = (dir: 1 | -1) => {
    const page = pageSize.current;
    if (!liveRef.current || page.width === 0 || !viewportRef.current) return;
    const box = mirrorBox();
    const from = anim.current?.target ?? viewRef.current;
    animateTo(zoomAt(from, { x: box.left + box.width / 2, y: box.top + box.height / 2 }, zoomStep(from.scale, dir), box, page, controlsInset()));
  };

  /** The help sheet: whatever the fingers were doing ends first (the mirror takes no input while it is open). */
  const openHelp = () => {
    flushUp();
    resetTouches();
    setHelping(true);
  };
  const closeHelp = () => {
    refocusHelp.current = true;
    setHelping(false);
  };
  const toggleDragMode = () => {
    const on = !dragModeRef.current;
    dragModeRef.current = on;
    setDragMode(on);
    setAnnounce(on ? 'Drag mode on' : 'Drag mode off');
  };
  /** A hold engaged: a short buzz where the phone can, and a ring under the finger. */
  const holdFeedback = (at: Point) => {
    try {
      navigator.vibrate?.(10);
    } catch {
      // vibration blocked (no user activation yet, or a policy): the ring still shows
    }
    const st = stageRef.current;
    if (!st) return;
    const r = st.getBoundingClientRect();
    if (holdRingTimer.current) clearTimeout(holdRingTimer.current);
    setHoldRing((prev) => ({ x: at.x - r.left, y: at.y - r.top, n: (prev?.n ?? 0) + 1 }));
    holdRingTimer.current = setTimeout(() => {
      holdRingTimer.current = null;
      setHoldRing(null);
    }, HOLD_RING_MS);
  };

  /** Sends a tap's delayed release now (a new press, or its timer). */
  // A function declaration (hoisted): `send`, created on the first render, flushes through it too. Refs only.
  function flushUp() {
    const u = pendingUp.current;
    if (!u) return;
    clearTimeout(u.timer);
    pendingUp.current = null;
    pressed.current = null;
    // Always sent, like any release: a press is never left down on the page.
    send({ t: 'mouse', action: 'up', ...u.p, button: u.button, clickCount: 1, modifiers: 0 });
  }
  /** Sends a press at page point `p`; `at` (client px) is where it started, for telling a tap from a drag. */
  const press = (at: Point, p: Point, button: 'left' | 'middle' | 'right', modifiers: number) => {
    flushUp(); // a tap's release still on its way goes first
    pressed.current = button;
    tapRef.current = { x: at.x, y: at.y, field: hitField(fieldsRef.current, p) };
    lastMove.current = p; // a press puts the pointer there too
    send({ t: 'mouse', action: 'down', ...p, button, clickCount: 1, modifiers });
  };

  /** For a tap (not a drag): the keyboard for the field under it, or closing it elsewhere. */
  const afterTap = (e: { clientX: number; clientY: number }) => {
    // Focusing on release is what iOS honours most reliably, and a drag that starts on a field doesn't open the keyboard.
    const tap = tapRef.current;
    tapRef.current = null;
    if (!tap || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= TAP_SLOP_PX) return;
    if (tap.field) openBridge(tap.field.kind, tap.field);
    // Only a keyboard a field tap opened closes on a tap elsewhere: the Keyboard button's stays (older engines send no
    // map, and fields the map can't see, like cross-origin frames, still need typing).
    else if (document.activeElement === bridgeRef.current && mappedTap.current) closeBridge();
  };

  /** Always pair a press with a release, even if the pointer ended in the letterbox or was cancelled. */
  const release = (e: { clientX: number; clientY: number }, modifiers = modifiersOf(e as PointerEvent)) => {
    const button = pressed.current;
    if (!button || pendingUp.current || !viewportRef.current) return; // a tap's release is already on its way
    const p = clampToPage({ x: e.clientX, y: e.clientY }, mirrorBox(), pageSize.current, viewRef.current);
    if (!p) return;
    pressed.current = null;
    pressTouch.current = null;
    (e as Partial<PointerEvent>).preventDefault?.();
    // Sliders read the position from the last mousemove: move to the release point first if the page isn't there yet.
    trailingMove.current = null;
    const last = lastMove.current;
    if (last && (last.x !== p.x || last.y !== p.y)) sendMove({ t: 'mouse', action: 'move', ...p, button, clickCount: 0, modifiers });
    send({ t: 'mouse', action: 'up', ...p, button, clickCount: 1, modifiers });
  };

  const dropHeld = () => {
    if (held.current) clearTimeout(held.current.timer);
    held.current = null;
  };
  /** Sends the scroll a swipe has built up (page px), where the swipe landed; nothing when it rounds to zero. */
  const sendWheel = () => {
    const due = wheelDue.current;
    const p = swipe.current?.p ?? null;
    const dx = Math.round(due.dx * 10) / 10 || 0; // never -0
    const dy = Math.round(due.dy * 10) / 10 || 0;
    if (!p || (dx === 0 && dy === 0)) return false;
    due.dx -= dx;
    due.dy -= dy;
    send({ t: 'wheel', ...p, dx, dy });
    return true;
  };
  /** At most one wheel per MOVE_MS: sent now if the tick is free, else at the end of the tick (with what came since). */
  const throttleWheel = () => {
    if (wheelTimer.current) return;
    if (!sendWheel()) return;
    const tickEnd = () => {
      wheelTimer.current = null;
      if (liveRef.current && sendWheel()) wheelTimer.current = setTimeout(tickEnd, MOVE_MS);
    };
    wheelTimer.current = setTimeout(tickEnd, MOVE_MS);
  };
  /**
   * A swipe ends (the lift, a second finger, a reset): what is left of its scroll goes now, if live. A cancel
   * (`flush` false: the browser took the touch away) drops it.
   */
  const endSwipe = (flush = true) => {
    if (!swipe.current) return;
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    wheelTimer.current = null;
    if (flush && liveRef.current) sendWheel();
    swipe.current = null;
    wheelDue.current = { dx: 0, dy: 0 };
  };
  /**
   * The swiping finger moved to `at` (client px): the zoomed view pans with it as far as it can, and the rest scrolls
   * the page (screen px to page px through the current scale; the content follows the finger, so the sign flips).
   */
  const swipeTo = (at: Point) => {
    const sw = swipe.current!;
    let dx = at.x - sw.x;
    let dy = at.y - sw.y;
    sw.x = at.x;
    sw.y = at.y;
    const page = pageSize.current;
    if (!viewportRef.current || page.width === 0) return;
    const box = mirrorBox();
    const v = viewRef.current;
    if (!isFit(v)) {
      // Pan from the view as it should be (in range of the mirror now): a correction to a stale view is not a scroll.
      const inset = controlsInset();
      const base = clampView(v, box, page, inset);
      const panned = clampView({ scale: base.scale, x: base.x + dx, y: base.y + dy }, box, page, inset);
      if (panned.x !== v.x || panned.y !== v.y) setView(panned);
      dx -= panned.x - base.x;
      dy -= panned.y - base.y;
    }
    // The page scrolls along the swipe's axis only (the view above pans freely).
    if (sw.axis === 'y') dx = 0;
    if (sw.axis === 'x') dy = 0;
    const k = page.width / imageRect(box, page, viewRef.current).width;
    if (!Number.isFinite(k)) return;
    wheelDue.current.dx -= dx * k;
    wheelDue.current.dy -= dy * k;
    throttleWheel();
  };
  /** A held-back finger becomes a press (it moved past the slop, or stayed down): sent where it landed. */
  const commitHeld = () => {
    const h = held.current;
    dropHeld();
    if (!h || !h.p || !liveRef.current) return;
    press(h, h.p, 'left', 0);
    pressTouch.current = { id: h.id, x: h.x, y: h.y };
  };
  /** The finger stayed still for HOLD_MS: pressed there, and the person feels and sees it. */
  const holdEngaged = () => {
    const h = held.current;
    commitHeld();
    if (h && pressed.current) holdFeedback(h);
  };
  /**
   * Forgets every finger: a lift that was never reported (a lost capture, the page hidden, the session no longer live,
   * a new first finger) must not leave a pinch or a held finger behind. A press already sent is released where its
   * finger was last seen.
   */
  const resetTouches = () => {
    dropHeld();
    endSwipe();
    const pt = pressTouch.current;
    if (pt && pressed.current) release({ clientX: pt.x, clientY: pt.y }, 0);
    pressTouch.current = null;
    touches.current.clear();
    pinch.current = null;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!liveRef.current) return;
    if (e.pointerType !== 'touch') {
      const p = point(e);
      if (!p) return;
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      return press({ x: e.clientX, y: e.clientY }, p, BUTTONS[e.button] ?? 'left', modifiersOf(e));
    }
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    stopZoomAnimation(); // a finger landing mid-zoom holds the view where it is
    if (e.isPrimary ?? touches.current.size === 0) resetTouches();
    const at = { x: e.clientX, y: e.clientY };
    touches.current.set(e.pointerId, at);
    if (touches.current.size === 1) {
      held.current = { id: e.pointerId, ...at, p: point(e), downAt: performance.now(), timer: setTimeout(holdEngaged, HOLD_MS) };
      return;
    }
    if (touches.current.size !== 2 || pinch.current) return; // a third finger: ignored
    // A second finger: a pinch. A swipe ends (its scroll so far goes); a press already sent is released first, where
    // the first finger is.
    dropHeld();
    endSwipe();
    const [firstId, first] = [...touches.current][0]!;
    if (pressed.current) release({ clientX: first.x, clientY: first.y }, 0);
    pressTouch.current = null;
    tapRef.current = null;
    pinch.current = { ids: [firstId, e.pointerId], from: pinchOf(first, at), start: viewRef.current };
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') {
      release(e); // a press is always released, even when the session stopped being live in between
      if (liveRef.current) afterTap(e);
      return;
    }
    const known = touches.current.delete(e.pointerId);
    if (pinch.current) {
      if (touches.current.size === 0) pinch.current = null;
      return;
    }
    if (swipe.current?.id === e.pointerId) return endSwipe(); // a swipe's lift: the rest of its scroll, no click
    const h = held.current;
    if (h && h.id === e.pointerId) {
      dropHeld();
      if (!liveRef.current || !h.p) return; // not live, or the letterbox: nothing to tap
      // A tap: the press now, the keyboard now (inside the touch's own handler, or iOS won't open it), and the
      // release once the finger's real time down has passed, where it pressed.
      press(h, h.p, 'left', 0);
      afterTap(e);
      const ms = Math.min(TAP_MAX_MS, Math.max(TAP_MIN_MS, performance.now() - h.downAt));
      pendingUp.current = { p: h.p, button: 'left', timer: setTimeout(flushUp, ms) };
      return;
    }
    // The finger whose press was sent (a drag or a hold); a lift the mirror never saw go down sends nothing.
    if (!known || pressTouch.current?.id !== e.pointerId) return;
    release(e);
    if (liveRef.current) afterTap(e);
  };

  const cancel = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      touches.current.delete(e.pointerId);
      if (held.current?.id === e.pointerId) dropHeld();
      if (swipe.current?.id === e.pointerId) endSwipe(false);
      if (pinch.current && touches.current.size === 0) pinch.current = null;
      if (pressTouch.current?.id !== e.pointerId) return;
    }
    tapRef.current = null;
    release(e);
  };
  /** The browser took the pointer away without a lift or a cancel (e.g. an element went away): start clean. */
  const lostCapture = (e: PointerEvent) => {
    if (touches.current.has(e.pointerId)) resetTouches();
  };

  const scroll = (direction: 1 | -1) => {
    const page = pageSize.current;
    if (!liveRef.current || page.width === 0) return;
    // The part of the page on screen: at fit all of it, zoomed in only what the person sees.
    const seen = viewportRef.current ? visiblePageRect(mirrorBox(), page, viewRef.current) : null;
    const v = seen && seen.width > 0 ? seen : { left: 0, top: 0, ...page };
    send({ t: 'wheel', x: v.left + v.width / 2, y: v.top + v.height / 2, dx: 0, dy: Math.round(direction * v.height * SCROLL_FRACTION) });
  };

  const sendMove = (m: Extract<ViewerToEngine, { t: 'mouse' }>) => {
    lastMove.current = { x: m.x, y: m.y };
    send(m);
  };

  /**
   * At most one move per MOVE_MS; `then` runs when the tick ends (a drag's first move). A move that arrived during the
   * tick isn't lost: the newest one is sent when the tick ends (one tick later still if `then` sent a move).
   */
  const throttleMoves = (then?: () => void) => {
    moveQueued.current = true;
    moveTimer.current = setTimeout(() => {
      moveQueued.current = false;
      moveTimer.current = null;
      if (then) {
        then();
        if (trailingMove.current) throttleMoves();
        return;
      }
      const m = trailingMove.current;
      trailingMove.current = null;
      // A held button's move only while it is still held (a release already went out at the lift point).
      if (!m || !liveRef.current || (m.button !== 'none' && !pressed.current)) return;
      throttleMoves();
      sendMove(m);
    }, MOVE_MS);
  };

  const onMove = (e: PointerEvent) => {
    if (!liveRef.current) return;
    if (e.pointerType === 'touch') {
      if (!touches.current.has(e.pointerId)) return;
      const at = { x: e.clientX, y: e.clientY };
      touches.current.set(e.pointerId, at);
      const pz = pinch.current;
      if (pz) {
        const [a, b] = pz.ids.map((id) => touches.current.get(id));
        if (a && b && viewportRef.current) setView(pinchView(pz.start, pz.from, pinchOf(a, b), mirrorBox(), pageSize.current, controlsInset()));
        return;
      }
      if (swipe.current?.id === e.pointerId) return swipeTo(at);
      const h = held.current;
      if (h && h.id === e.pointerId) {
        if (Math.hypot(at.x - h.x, at.y - h.y) < TAP_SLOP_PX) return;
        if (!dragModeRef.current) {
          // A swipe: a move from where the finger landed, so the content follows the finger all the way. Its axis is
          // set by how it started: mostly up/down or mostly sideways scrolls that axis only.
          dropHeld();
          const ax = Math.abs(at.x - h.x);
          const ay = Math.abs(at.y - h.y);
          const page = pageSize.current;
          const landed = clampToPage(h, mirrorBox(), page, viewRef.current);
          swipe.current = {
            id: h.id,
            x: h.x,
            y: h.y,
            p: landed && { x: Math.min(landed.x, page.width - 1), y: Math.min(landed.y, page.height - 1) },
            axis: ay > 2 * ax ? 'y' : ax > 2 * ay ? 'x' : 'free',
          };
          wheelDue.current = { dx: 0, dy: 0 };
          return swipeTo(at);
        }
        // Drag mode: the press now, the move to where it crossed the slop one tick later (never in the same tick).
        commitHeld();
        const p = point(e);
        if (!pressed.current || !p) return;
        pressTouch.current = { id: e.pointerId, ...at };
        return throttleMoves(() => {
          if (pressed.current && liveRef.current) sendMove({ t: 'mouse', action: 'move', ...p, button: 'left', clickCount: 0, modifiers: 0 });
        });
      }
      if (pressTouch.current?.id !== e.pointerId) return;
      pressTouch.current = { id: e.pointerId, ...at };
    }
    const p = point(e);
    if (!p) return;
    const m = { t: 'mouse', action: 'move', ...p, button: e.buttons & 1 ? 'left' : 'none', clickCount: 0, modifiers: modifiersOf(e) } as const;
    if (moveQueued.current) {
      trailingMove.current = m;
      return;
    }
    throttleMoves();
    sendMove(m);
  };

  const onWheel = (e: WheelEvent) => {
    if (!liveRef.current) return;
    if (e.ctrlKey) {
      // A trackpad pinch on a computer (and ctrl + wheel): zoom the mirror around the pointer, nothing to the page.
      if (pageSize.current.width === 0 || !viewportRef.current) return;
      e.preventDefault();
      stopZoomAnimation();
      const v = viewRef.current;
      return setView(zoomAt(v, { x: e.clientX, y: e.clientY }, v.scale * Math.exp(-e.deltaY / 100), mirrorBox(), pageSize.current, controlsInset()));
    }
    const p = point(e);
    if (!p) return;
    e.preventDefault();
    send({ t: 'wheel', ...p, dx: e.deltaX, dy: e.deltaY });
  };

  // The handlers read the session state from refs, so they are attached once per mirror, not on every render.
  useEffect(() => {
    // On the viewport, not the canvas: zoomed and panned, the canvas no longer covers all of the mirror's box.
    const c = viewportRef.current;
    if (!c) return;
    const noMenu = (e: Event) => e.preventDefault();
    // Safari's own page pinch (gesture events) would zoom the whole viewer, bars included.
    const noGesture = (e: Event) => e.preventDefault();
    const onHidden = () => {
      if (document.visibilityState === 'hidden') resetTouches();
    };
    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointerup', onPointerUp);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointercancel', cancel);
    c.addEventListener('lostpointercapture', lostCapture);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('contextmenu', noMenu);
    document.addEventListener('gesturestart', noGesture);
    document.addEventListener('gesturechange', noGesture);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      c.removeEventListener('pointerdown', onPointerDown);
      c.removeEventListener('pointerup', onPointerUp);
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointercancel', cancel);
      c.removeEventListener('lostpointercapture', lostCapture);
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('contextmenu', noMenu);
      document.removeEventListener('gesturestart', noGesture);
      document.removeEventListener('gesturechange', noGesture);
      document.removeEventListener('visibilitychange', onHidden);
      // Nothing left running after the mirror goes: no held finger, no tap release, no move tick, no zoom animation.
      dropHeld();
      if (pendingUp.current) clearTimeout(pendingUp.current.timer);
      pendingUp.current = null;
      if (moveTimer.current) clearTimeout(moveTimer.current);
      moveTimer.current = null;
      trailingMove.current = null;
      if (wheelTimer.current) clearTimeout(wheelTimer.current);
      wheelTimer.current = null;
      swipe.current = null;
      wheelDue.current = { dx: 0, dy: 0 };
      if (holdRingTimer.current) clearTimeout(holdRingTimer.current);
      holdRingTimer.current = null;
      lastMove.current = null;
      moveQueued.current = false; // a mirror mounted again must not start with its moves throttled away
      stopZoomAnimation();
    };
  }, [screen.kind, started]);

  // The session left live (reconnecting, ended): no finger state survives it.
  useEffect(() => {
    if (!live) resetTouches();
  }, [live]);

  // Help closed: focus goes back to its button, once the viewer behind the sheet is no longer inert.
  useEffect(() => {
    if (helping || !refocusHelp.current) return;
    refocusHelp.current = false;
    helpButton.current?.focus({ preventScroll: true });
  }, [helping]);

  // The keyboard bridge: every key the person presses goes straight to the agent's page.
  useEffect(() => {
    const el = bridgeRef.current;
    const form = formRef.current;
    if (!el || !form) return;
    configureBridge(el, 'text');
    const detach = attachBridge(el, form, { send, kind: () => bridgeKind.current });
    const unlift = () => {
      if (stageRef.current) stageRef.current.style.transform = '';
      ringField.current = null;
      setRing(null);
      setTyping(false);
    };
    const typingOn = () => setTyping(true);
    el.addEventListener('blur', unlift);
    el.addEventListener('focus', typingOn);
    return () => {
      detach();
      el.removeEventListener('blur', unlift);
      el.removeEventListener('focus', typingOn);
    };
  }, [screen.kind, started]);

  // The mirror's area can change size while a field is outlined (Android resizes the page as the keyboard opens and
  // hides, a phone rotates): place the outline and the typing box over the field again.
  useEffect(() => {
    const reposition = () => {
      // Zoomed: keep the view in range of the new size (setView also places the outline again).
      if (!isFit(viewRef.current) && viewportRef.current) return setView(clampView(viewRef.current, mirrorBox(), pageSize.current, controlsInset()));
      const field = ringField.current;
      if (field && canvasRef.current && stageRef.current) placeOver(field);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null;
    if (viewportRef.current) observer?.observe(viewportRef.current);
    if (stageRef.current) observer?.observe(stageRef.current);
    window.addEventListener('resize', reposition);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', reposition);
    };
  }, [screen.kind, started]);

  // Keep the field in view: when the keyboard shrinks the visible area, lift the mirror so the field sits above it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => relift();
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [screen.kind, started]);

  if (screen.kind === 'message') {
    return (
      <main class={`message tone-${screen.tone}`}>
        <div class="message-card">
          <h1>{screen.title}</h1>
          <p>{screen.body}</p>
        </div>
      </main>
    );
  }

  if (!started && startMode) {
    const copy = START_COPY[startMode];
    const about = startMode === 'question' ? alert?.question : alert?.reason;
    return (
      <main class="message start">
        <div class="message-card">
          <p class="start-kicker">Unstuck</p>
          <h1>{copy.title}</h1>
          {about ? <p class="start-about">{about}</p> : null}
          {startMode === 'approval' && alert?.site ? <p class="site">{cleanLabel(alert.site, 253)}</p> : null}
          {sender && sender !== 'not_sent' ? <p class="from">{fromLine(sender.keyName, alert?.site ?? '')}</p> : null}
          {sender === 'not_sent' ? (
            <p class="not-sent" role="alert">
              {NOT_SENT}
            </p>
          ) : null}
          <p>{copy.lede}</p>
          <button type="button" class="btn btn-primary btn-start" onClick={() => setStarted(true)}>
            {copy.button}
          </button>
          <p class="start-note">Opening this link in a preview doesn't use it.</p>
        </div>
      </main>
    );
  }

  if (!started) {
    return (
      <main class="message start">
        <div class="message-card">
          <p class="start-kicker">Unstuck</p>
          <h1>{alert?.reason ?? 'Someone needs your help in a browser'}</h1>
          {alert?.site ? <p class="site">{cleanLabel(alert.site, 253)}</p> : null}
          {sender && sender !== 'not_sent' ? <p class="from">{fromLine(sender.keyName, alert?.site ?? '')}</p> : null}
          {sender === 'not_sent' ? (
            <p class="not-sent" role="alert">
              {NOT_SENT}
            </p>
          ) : null}
          <p>{alert ? "Tap Start to see the agent's browser and solve it." : "An AI agent is stuck and asked a person to take over its browser for a moment. Tap Start to see it."}</p>
          <button type="button" class="btn btn-primary btn-start" onClick={() => setStarted(true)}>
            Start takeover
          </button>
          <p class="start-note">Only one person can take over. Opening this link in a preview doesn't use it.</p>
        </div>
      </main>
    );
  }

  if (answered || modeFrame?.mode === 'question' || modeFrame?.mode === 'approval') {
    const left = info ? remaining : undefined;
    return !modeFrame || modeFrame.mode === 'question' ? (
      <QuestionScreen question={modeFrame?.question} agentName={modeFrame?.agentName} answer={answered ?? undefined} answered={!!answered} remaining={left} embed={embed} errors={errors} onAnswer={(a) => send({ t: 'answer', ...a })} />
    ) : (
      <ApprovalScreen reason={modeFrame.reason} site={modeFrame.site} canvasRef={approvalCanvas} remaining={left} embed={embed} checking={approvalChecking} onApproved={() => send({ t: 'approved' })} onShowPage={() => send({ t: 'switch_control' })} />
    );
  }

  return (
    <div class={embed ? 'app embed' : 'app'}>
      {/* While Help is open everything behind it is inert: no taps, no focus, nothing for a screen reader. */}
      {embed ? null : (
      <header class="topbar" inert={helping}>
        <div class="topbar-text">
          <p class="reason">{info?.reason ?? alert?.reason ?? 'Connecting to the agent…'}</p>
          {site ? <p class="site">{site}</p> : null}
          {sender && sender !== 'not_sent' ? <p class="from">{fromLine(sender.keyName, alert?.site ?? '')}</p> : null}
          {sender === 'not_sent' ? (
            <p class="not-sent" role="alert">
              {NOT_SENT}
            </p>
          ) : null}
        </div>
        {info ? (
          <span class="countdown" data-testid="countdown" aria-label={`Time left ${remaining}`}>
            {remaining}
          </span>
        ) : null}
        <TipButton tips={tips} id="help" side="bottom" align="end" class="btn rail-btn help-btn" label="Help" tip="How to tap, move, drag and zoom." buttonRef={helpButton} onClick={openHelp}>
          <HelpIcon />
        </TipButton>
      </header>
      )}

      <div class="stage" ref={stageRef} inert={helping}>
        <div class="viewport" ref={viewportRef}>
          <canvas
            ref={canvasRef}
            data-testid="screen"
            data-framed={framed ? '' : undefined}
            class="screen"
            aria-label="Live view of the agent's browser. Tap or click to interact, swipe to move, press and hold to drag. Pinch or use + to zoom."
          />
        </div>
        {/* mousedown is not allowed to move focus: zooming and scrolling keep the phone keyboard open over its field. */}
        <div class="stage-controls tool-rail" ref={controlsRef} onMouseDown={(e) => e.preventDefault()}>
          <div class="control-group" role="group" aria-label="Zoom">
            <TipButton tips={tips} id="zoom-in" side="left" class="btn rail-btn" label="Zoom in" tip="Zoom in (or pinch)." disabled={zoomed === 'max'} onClick={() => zoomButton(1)}>
              <ZoomInIcon />
            </TipButton>
            <TipButton tips={tips} id="zoom-out" side="left" class="btn rail-btn" label="Zoom out" tip="Zoom out." disabled={zoomed === 'fit'} onClick={() => zoomButton(-1)}>
              <ZoomOutIcon />
            </TipButton>
            <TipButton tips={tips} id="fit" side="left" class="btn rail-btn" label="Fit page to screen" tip="Fit the page to the screen." disabled={zoomed === 'fit'} onClick={() => liveRef.current && animateTo(FIT_VIEW)}>
              <FitIcon />
            </TipButton>
          </div>
          <div class="rail-divider" aria-hidden="true" />
          <div class="control-group" role="group" aria-label="Scroll">
            <TipButton tips={tips} id="scroll-up" side="left" class="btn rail-btn" label="Scroll up" tip="Scroll the page up." onClick={() => scroll(-1)}>
              <ChevronUpIcon />
            </TipButton>
            <TipButton tips={tips} id="scroll-down" side="left" class="btn rail-btn" label="Scroll down" tip="Scroll the page down." onClick={() => scroll(1)}>
              <ChevronDownIcon />
            </TipButton>
          </div>
          <div class="rail-divider" aria-hidden="true" />
          <div class="control-group" role="group" aria-label="Touch">
            <TipButton
              tips={tips}
              id="drag-mode"
              side="left"
              class="btn rail-btn rail-toggle"
              label="Drag mode"
              pressed={dragMode}
              tip={dragMode ? DRAG_TIP_ON : DRAG_TIP_OFF}
              onClick={toggleDragMode}
            >
              <DragIcon />
            </TipButton>
          </div>
        </div>
        {holdRing ? <span key={holdRing.n} data-testid="hold-ring" class="hold-ring" aria-hidden="true" style={{ left: `${holdRing.x}px`, top: `${holdRing.y}px` }} /> : null}
        <p class="sr-only" aria-live="polite" data-testid="announce">
          {announce}
        </p>
        {hint && !embed ? (
          <p class="first-hint" role="note">
            {hint}
          </p>
        ) : null}
        {ring ? (
          <div
            data-testid="focus-ring"
            class="focus-ring"
            aria-hidden="true"
            style={{ left: `${ring.left}px`, top: `${ring.top}px`, width: `${ring.width}px`, height: `${ring.height}px` }}
          />
        ) : null}
        <form ref={formRef} class="keyboard-form" action="#">
          <input ref={bridgeRef} data-testid="keyboard-bridge" class="keyboard-bridge" aria-label="Type into the agent's page" />
        </form>
        {chip ? (
          <button type="button" class="btn type-here" onClick={() => openBridge(chip, null)}>
            Type here
          </button>
        ) : null}
        {waitingForFrame ? (
          <div class="first-frame" role="status">
            <p>Waiting for the page…</p>
            {slowFirstFrame ? <p class="first-frame-hint">The page hasn't sent a picture yet. It may still be loading.</p> : null}
          </div>
        ) : null}
        {phase !== 'live' ? (
          <div class="banner" role="status">
            {phase === 'reconnecting' ? 'Connection dropped. Reconnecting…' : 'Connecting…'}
          </div>
        ) : null}
      </div>

      <footer class="bottombar" inert={helping}>
        <TipButton tips={tips} id="keyboard" side="top" align="start" class="btn bar-btn bar-neutral" active={typing} tip="Open your keyboard to type into the field you tapped." onClick={() => openBridge('text', null)}>
          <KeyboardIcon />
          <span class="bar-label">Keyboard</span>
        </TipButton>
        <TipButton
          tips={tips}
          id="cant-solve"
          side="top"
          class="btn bar-btn bar-neutral"
          tip="Hand the page back to the agent and say why you couldn't finish."
          onClick={() => {
            flushUp(); // the sheet takes the session off the mirror: end a tap first
            setAsking(true);
          }}
        >
          <FlagIcon />
          <span class="bar-label">Can't solve</span>
        </TipButton>
        <TipButton
          tips={tips}
          id="done"
          side="top"
          align="end"
          avoid={() => controlsRef.current}
          class="btn bar-btn bar-primary"
          tip="Finished. The agent takes the page back."
          onClick={() => {
            flushUp();
            send({ t: 'done' });
          }}
        >
          <CheckIcon />
          <span class="bar-label">Done</span>
        </TipButton>
      </footer>

      {codeAsk ? (
        <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="code-title">
          <form
            class="sheet-card"
            onSubmit={(e) => {
              e.preventDefault();
              sockRef.current?.sendHello(code.trim());
            }}
          >
            <h2 id="code-title">One more step</h2>
            <label for="code-input">Enter the 6-digit code</label>
            <input
              id="code-input"
              class="code-input"
              inputMode="numeric"
              autocomplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onInput={(e) => setCode((e.target as HTMLInputElement).value)}
            />
            {codeAsk.invalid ? (
              <p class="code-error" role="alert">
                That code is not right.
              </p>
            ) : null}
            <button type="submit" class="btn btn-primary">
              Continue
            </button>
          </form>
        </div>
      ) : null}

      {helping ? <HelpSheet onClose={closeHelp} /> : null}

      {asking ? (
        <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="cant-title">
          <form
            class="sheet-card"
            onSubmit={(e) => {
              e.preventDefault();
              const r = reason.trim();
              send(r ? { t: 'cant_solve', reason: r } : { t: 'cant_solve' });
            }}
          >
            <h2 id="cant-title">Hand this back to the agent?</h2>
            <label for="cant-reason">What went wrong? (optional)</label>
            <input id="cant-reason" value={reason} maxLength={200} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
            <div class="sheet-actions">
              <button type="button" class="btn btn-ghost" onClick={() => setAsking(false)}>
                Keep trying
              </button>
              <button type="submit" class="btn btn-danger">
                Send to agent
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
