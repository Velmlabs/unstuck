import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import type { Field, FieldKind, Frame, SessionStatus, ViewerErrorCode, ViewerToEngine } from '@velmlabs/unstuck-protocol';
import { connect as defaultConnect, e2eCodec, type Codec, type ConnectionHandlers, type Phase, type ViewerSocket } from './connection';
import { importE2eKey } from '@velmlabs/unstuck-protocol';
import { drawFrameOnCanvas } from './draw';
import { attachBridge, configureBridge } from './bridge';
import { bridgeBox, fieldBox, hitField, liftOffset, type Box } from './fields';
import { keyEventToMessage, modifiersOf } from './keys';
import { FIT_VIEW, MAX_ZOOM, clampToPage, clampView, isFit, pinchView, sizeChangedALot, toPagePoint, viewTransform, visiblePageRect, zoomAt, type Pinch, type Point, type Rect, type View } from './mapping';
import { forgetFragment, parseFragment, relayFor, sessionIdFromPath } from './url';
import { cleanLabel, type Sender } from './alert-link';

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
  alert?: { reason: string; site: string; sender?: () => Promise<Sender> };
}

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
 * - One finger is held back until it means something: a release within TAP_SLOP_PX is a tap (press and release sent
 *   together, so the first tap of a double tap is a click as always); moving past the slop is a drag (the press is
 *   sent where the finger landed, then the moves); staying down HOLD_MS is a press-and-hold (the press is sent then).
 *   Until then a second finger can still turn it into a pinch without the page ever seeing a click.
 * - Two fingers pinch to zoom around their midpoint and pan as the midpoint moves. A second finger after a press was
 *   sent ends that press (a release where the first finger is) before the pinch starts. Nothing reaches the page;
 *   a finger left over after a pinch does nothing until it lifts.
 * - A double tap (a second tap within DOUBLE_TAP_MS of the first tap's release and DOUBLE_TAP_PX of it) zooms 2× around
 *   it, or back to fit when zoomed, instead of clicking a second time. Not after a tap on a mapped text field: a second
 *   tap there is a click (moving the caret, selecting a word).
 */
const HOLD_MS = 250;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;
/** Zoom buttons step by √2 (fit, 1.4×, 2×, 2.8×, 4×); a double tap zooms 2×. */
const DOUBLE_TAP_ZOOM = 2;
const ZOOM_ANIM_MS = 180;
const reducedMotion = () =>
  typeof window.matchMedia !== 'function' || typeof requestAnimationFrame !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The next zoom button step from `scale`, on the √2 ladder (a pinch can leave the zoom between steps). */
const zoomStep = (scale: number, dir: 1 | -1) => {
  const level = Math.log2(scale) * 2;
  return 2 ** ((dir > 0 ? Math.floor(level + 1e-6) + 1 : Math.ceil(level - 1e-6) - 1) / 2);
};
const pinchOf = (a: Point, b: Point): Pinch => ({ mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) });

/** "From your key <name> · <site>", both as plain text without control, zero-width or bidi characters. */
function fromLine(keyName: string, sealedSite: string): string {
  const site = cleanLabel(sealedSite, 253);
  return `From your key ${cleanLabel(keyName)}${site ? ` · ${site}` : ''}`;
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
  const [started, setStarted] = useState(() => !!(sessionId && resumeStore.get(sessionId)));
  const [codeAsk, setCodeAsk] = useState<{ invalid: boolean } | null>(null);
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('connecting');
  const [info, setInfo] = useState<{ reason: string; site: string; expiresAt: number } | null>(null);
  const [remaining, setRemaining] = useState('');
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
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
  /** Touch pointers down on the mirror, a finger held back (see the gesture rules above), a pinch, the last tap. */
  const touches = useRef(new Map<number, Point>());
  const held = useRef<{ id: number; x: number; y: number; p: Point | null; doubleTap: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const pinch = useRef<{ ids: [number, number]; from: Pinch; start: View } | null>(null);
  const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);
  /** Nothing drawn yet: the black area says it is waiting for the page, not broken. */
  const [framed, setFramed] = useState(false);
  const framedRef = useRef(false);
  const [slowFirstFrame, setSlowFirstFrame] = useState(false);
  const moveQueued = useRef(false);
  const pressed = useRef<'left' | 'middle' | 'right' | null>(null);
  const site = info?.site || alert?.site || '';
  const live = screen.kind === 'session' && phase === 'live';
  const liveRef = useRef(live);
  liveRef.current = live && !asking;

  const send = useCallback((m: ViewerToEngine) => {
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
          if (sizeChangedALot(before, pageSize.current)) {
            setView(FIT_VIEW);
            lastTap.current = null; // a tap on another page is not the second half of a double tap
          }
          else if (!isFit(viewRef.current) && viewportRef.current) setView(clampView(viewRef.current, mirrorBox(), pageSize.current));
        }
        // Frame credit: the engine sends the next frame once this one is on screen (a slow phone never builds a backlog).
        const drawn = (d: Frame) => sockRef.current?.ack(d);
        if (canvasRef.current) drawFrame(canvasRef.current, f, drawn);
        else drawn(f);
        if (!framedRef.current) {
          framedRef.current = true;
          setFramed(true);
        }
      },
      onState: (s) => {
        const final = FINAL_SCREENS[s];
        if (final) {
          resumeStore.set(sessionId, null);
          setScreen(final);
          sockRef.current?.close();
        }
      },
      onError: (code) => {
        // An error that ends this link for good: the secret kept for reloads goes with it.
        if (code === 'token_used' || code === 'expired' || code === 'session_closed' || code === 'token_invalid') resumeStore.set(sessionId, null);
        if (code in ERROR_SCREENS) setScreen(ERROR_SCREENS[code as keyof typeof ERROR_SCREENS]);
      },
      onPhase: (p) => {
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
      if (!liveRef.current || e.target === bridgeRef.current) return;
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
    setRing(field ? ringOver(field) : null);
    relift(); // the keyboard may already be open (another field was being typed into)
  };
  /** Where a field (or, for null, the mirror's bottom strip) sits over the mirror, in CSS px of the stage. */
  const canvasRect = () => {
    const cr = viewportRef.current!.getBoundingClientRect();
    const sr = stageRef.current!.getBoundingClientRect();
    return { left: cr.left - sr.left, top: cr.top - sr.top, width: cr.width, height: cr.height };
  };
  const boxOver = (field: Field | null): Box => bridgeBox(field, canvasRect(), pageSize.current, viewRef.current);
  /** The outline: the field's exact box, with no minimum size. */
  const ringOver = (field: Field): Box => fieldBox(field, canvasRect(), pageSize.current, viewRef.current);
  /** Moves the outline and the typing box over the field the page now focuses, keeping the keyboard open. */
  const placeOver = (field: Field) => {
    const el = bridgeRef.current;
    if (!el || !canvasRef.current || !stageRef.current) return;
    const box = boxOver(field);
    Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    bridgeBoxRef.current = box;
    ringField.current = field;
    setRing(ringOver(field));
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
  /** Zooms to `scale` around a client point (the mirror's centre by default). */
  const zoomTo = (scale: number, focal?: Point) => {
    const page = pageSize.current;
    if (!live || page.width === 0 || !viewportRef.current) return;
    const box = mirrorBox();
    const from = anim.current?.target ?? viewRef.current; // a second press mid-animation builds on where it is going
    animateTo(zoomAt(from, focal ?? { x: box.left + box.width / 2, y: box.top + box.height / 2 }, scale, box, page));
  };
  const zoomButton = (dir: 1 | -1) => zoomTo(zoomStep((anim.current?.target ?? viewRef.current).scale, dir));
  /** A double tap: 2× around the finger, or back to fit when zoomed. */
  const toggleZoomAt = (at: Point) => (isFit(viewRef.current) ? zoomTo(DOUBLE_TAP_ZOOM, at) : animateTo(FIT_VIEW));

  /** Sends a press at page point `p`; `at` (client px) is where it started, for telling a tap from a drag. */
  const press = (at: Point, p: Point, button: 'left' | 'middle' | 'right', modifiers: number) => {
    pressed.current = button;
    tapRef.current = { x: at.x, y: at.y, field: hitField(fieldsRef.current, p) };
    send({ t: 'mouse', action: 'down', ...p, button, clickCount: 1, modifiers });
  };

  /** A release; then, for a tap (not a drag), the keyboard for the field under it, or closing it elsewhere. */
  const endPress = (e: PointerEvent) => {
    release(e);
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
    if (!button || !viewportRef.current) return;
    const p = clampToPage({ x: e.clientX, y: e.clientY }, mirrorBox(), pageSize.current, viewRef.current);
    if (!p) return;
    pressed.current = null;
    (e as Partial<PointerEvent>).preventDefault?.();
    send({ t: 'mouse', action: 'up', ...p, button, clickCount: 1, modifiers });
  };

  /** A held-back finger becomes a press (it moved past the slop, or stayed down): sent where it landed. */
  const commitHeld = () => {
    const h = held.current;
    if (!h) return;
    clearTimeout(h.timer);
    held.current = null;
    if (h.p) press(h, h.p, 'left', 0);
  };
  const dropHeld = () => {
    if (held.current) clearTimeout(held.current.timer);
    held.current = null;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!live) return;
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
    const at = { x: e.clientX, y: e.clientY };
    touches.current.set(e.pointerId, at);
    if (touches.current.size === 1) {
      const last = lastTap.current;
      const p = point(e);
      const doubleTap =
        !!last && performance.now() - last.at <= DOUBLE_TAP_MS && Math.hypot(at.x - last.x, at.y - last.y) <= DOUBLE_TAP_PX && !(p && hitField(fieldsRef.current, p));
      held.current = { id: e.pointerId, ...at, p, doubleTap, timer: setTimeout(commitHeld, HOLD_MS) };
      return;
    }
    if (touches.current.size !== 2 || pinch.current) return;
    // A second finger: a pinch. A press already sent is released first, where the first finger is.
    dropHeld();
    const [firstId, first] = [...touches.current][0]!;
    if (pressed.current) release({ clientX: first.x, clientY: first.y }, 0);
    tapRef.current = null;
    lastTap.current = null;
    pinch.current = { ids: [firstId, e.pointerId], from: pinchOf(first, at), start: viewRef.current };
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') touches.current.delete(e.pointerId);
    if (pinch.current) {
      if (touches.current.size === 0) pinch.current = null;
      return;
    }
    const h = held.current;
    if (h && h.id === e.pointerId) dropHeld();
    if (!live) return;
    if (e.pointerType !== 'touch') return endPress(e);
    if (h && h.id === e.pointerId) {
      if (h.doubleTap) {
        lastTap.current = null;
        return toggleZoomAt(h);
      }
      if (h.p) {
        press(h, h.p, 'left', 0);
        const onField = tapRef.current?.field;
        endPress(e);
        lastTap.current = onField ? null : { x: h.x, y: h.y, at: performance.now() };
      } else lastTap.current = { x: h.x, y: h.y, at: performance.now() }; // the letterbox: no click, but a double tap zooms
      return;
    }
    lastTap.current = null;
    endPress(e);
  };

  const cancel = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      touches.current.delete(e.pointerId);
      if (held.current?.id === e.pointerId) dropHeld();
      if (pinch.current && touches.current.size === 0) pinch.current = null;
    }
    tapRef.current = null;
    release(e);
  };

  const scroll = (direction: 1 | -1) => {
    const page = pageSize.current;
    if (!live || page.width === 0) return;
    // The part of the page on screen: at fit all of it, zoomed in only what the person sees.
    const seen = viewportRef.current ? visiblePageRect(mirrorBox(), page, viewRef.current) : null;
    const v = seen && seen.width > 0 ? seen : { left: 0, top: 0, ...page };
    send({ t: 'wheel', x: v.left + v.width / 2, y: v.top + v.height / 2, dx: 0, dy: Math.round(direction * v.height * SCROLL_FRACTION) });
  };

  const onMove = (e: PointerEvent) => {
    if (!live) return;
    if (e.pointerType === 'touch') {
      if (!touches.current.has(e.pointerId)) return;
      const at = { x: e.clientX, y: e.clientY };
      touches.current.set(e.pointerId, at);
      const pz = pinch.current;
      if (pz) {
        const [a, b] = pz.ids.map((id) => touches.current.get(id));
        if (a && b && viewportRef.current) setView(pinchView(pz.start, pz.from, pinchOf(a, b), mirrorBox(), pageSize.current));
        return;
      }
      const h = held.current;
      if (h && Math.hypot(at.x - h.x, at.y - h.y) < TAP_SLOP_PX) return;
      commitHeld();
      if (!pressed.current) return;
    }
    if (moveQueued.current) return;
    const p = point(e);
    if (!p) return;
    moveQueued.current = true;
    setTimeout(() => (moveQueued.current = false), 16);
    send({ t: 'mouse', action: 'move', ...p, button: e.buttons & 1 ? 'left' : 'none', clickCount: 0, modifiers: modifiersOf(e) });
  };

  const onWheel = (e: WheelEvent) => {
    if (!live) return;
    if (e.ctrlKey) {
      // A trackpad pinch on a computer (and ctrl + wheel): zoom the mirror around the pointer, nothing to the page.
      if (pageSize.current.width === 0 || !viewportRef.current) return;
      e.preventDefault();
      stopZoomAnimation();
      return setView(zoomAt(viewRef.current, { x: e.clientX, y: e.clientY }, viewRef.current.scale * Math.exp(-e.deltaY / 100), mirrorBox(), pageSize.current));
    }
    const p = point(e);
    if (!p) return;
    e.preventDefault();
    send({ t: 'wheel', ...p, dx: e.deltaX, dy: e.deltaY });
  };

  useEffect(() => {
    // On the viewport, not the canvas: zoomed and panned, the canvas no longer covers all of the mirror's box.
    const c = viewportRef.current;
    if (!c) return;
    const down = onPointerDown;
    const up = onPointerUp;
    const noMenu = (e: Event) => e.preventDefault();
    c.addEventListener('pointerdown', down);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointermove', onMove);
    c.addEventListener('pointercancel', cancel);
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('contextmenu', noMenu);
    return () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('pointercancel', cancel);
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('contextmenu', noMenu);
    };
  });

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
    };
    el.addEventListener('blur', unlift);
    return () => {
      detach();
      el.removeEventListener('blur', unlift);
    };
  }, [screen.kind, started]);

  // The mirror's area can change size while a field is outlined (Android resizes the page as the keyboard opens and
  // hides, a phone rotates): place the outline and the typing box over the field again.
  useEffect(() => {
    const reposition = () => {
      // Zoomed: keep the view in range of the new size (setView also places the outline again).
      if (!isFit(viewRef.current) && viewportRef.current) return setView(clampView(viewRef.current, mirrorBox(), pageSize.current));
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

  return (
    <div class="app">
      <header class="topbar">
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
      </header>

      <div class="stage" ref={stageRef}>
        <div class="viewport" ref={viewportRef}>
          <canvas
            ref={canvasRef}
            data-testid="screen"
            class="screen"
            aria-label="Live view of the agent's browser. Tap or click to interact. Pinch or double-tap to zoom."
          />
        </div>
        <div class="stage-controls">
          {/* mousedown is not allowed to move focus: zooming keeps the phone keyboard open over its field. */}
          <div class="control-group" role="group" aria-label="Zoom" onMouseDown={(e) => e.preventDefault()}>
            <button type="button" class="btn btn-icon" aria-label="Zoom in" disabled={zoomed === 'max'} onClick={() => zoomButton(1)}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
              </svg>
            </button>
            <button type="button" class="btn btn-icon" aria-label="Zoom out" disabled={zoomed === 'fit'} onClick={() => zoomButton(-1)}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
              </svg>
            </button>
            <button type="button" class="btn btn-icon" aria-label="Fit page to screen" disabled={zoomed === 'fit'} onClick={() => animateTo(FIT_VIEW)}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>
          <div class="control-group" role="group" aria-label="Scroll">
          <button type="button" class="btn btn-icon" aria-label="Scroll up" onClick={() => scroll(-1)}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <button type="button" class="btn btn-icon" aria-label="Scroll down" onClick={() => scroll(1)}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          </div>
        </div>
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



      <footer class="bottombar">
        <button type="button" class="btn btn-ghost" onClick={() => openBridge('text', null)}>
          Keyboard
        </button>
        <button type="button" class="btn btn-secondary" onClick={() => setAsking(true)}>
          Can't solve
        </button>
        <button type="button" class="btn btn-primary" onClick={() => send({ t: 'done' })}>
          Done
        </button>
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
