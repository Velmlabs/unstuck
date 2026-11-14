import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import type { Field, FieldKind, Frame, SessionStatus, ViewerErrorCode, ViewerToEngine } from '@velmlabs/unstuck-protocol';
import { connect as defaultConnect, e2eCodec, type Codec, type ConnectionHandlers, type Phase, type ViewerSocket } from './connection';
import { importE2eKey } from '@velmlabs/unstuck-protocol';
import { drawFrameOnCanvas } from './draw';
import { attachBridge, configureBridge } from './bridge';
import { bridgeBox, fieldBox, hitField, liftOffset, type Box } from './fields';
import { keyEventToMessage, modifiersOf } from './keys';
import { clampToPage, toPagePoint } from './mapping';
import { forgetFragment, parseFragment, sessionIdFromPath, wsUrlFor } from './url';

export interface AppProps {
  location: { hash: string; pathname: string; origin: string };
  connectFn?: (url: string, token: string, codec: Codec, h: ConnectionHandlers, opts: { resumeKey?: string; alive?: () => Promise<boolean> }) => ViewerSocket;
  drawFrame?: (canvas: HTMLCanvasElement, frame: Frame) => void;
  now?: () => number;
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

/** A press that moves less than this (CSS px) before release is a tap, not a drag. */
const TAP_SLOP_PX = 10;

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function App({ location, connectFn = defaultConnect, drawFrame = drawFrameOnCanvas, now = Date.now }: AppProps) {
  const fragment = parseFragment(location.hash);
  const link = fragment && 'token' in fragment ? fragment : null;
  const token = link?.token;
  const sessionId = sessionIdFromPath(location.pathname);
  const [screen, setScreen] = useState<Screen>(
    token && sessionId ? { kind: 'session' } : fragment && 'error' in fragment ? INCOMPLETE_SCREEN : ERROR_SCREENS.token_invalid,
  );
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
  const sockRef = useRef<ViewerSocket | null>(null);
  const pageSize = useRef({ width: 0, height: 0 });
  const moveQueued = useRef(false);
  const pressed = useRef<'left' | 'middle' | 'right' | null>(null);
  const live = screen.kind === 'session' && phase === 'live';
  const liveRef = useRef(live);
  liveRef.current = live && !asking;

  const send = useCallback((m: ViewerToEngine) => {
    // The engine answers each tap and each typed key with a focus report: count them, so only the newest report acts.
    if ((m.t === 'mouse' && m.action === 'up') || (m.t === 'key' && m.action === 'down') || m.t === 'text') awaitingFocus.current++;
    sockRef.current?.send(m);
  }, []);

  useEffect(() => {
    if (!link || !token || !sessionId) return;
    const saved = resumeStore.get(sessionId);
    const sock = connectFn(wsUrlFor(location.origin, sessionId), token, lazyCodec(link.key, sessionId), {
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
        pageSize.current = { width: f.width, height: f.height };
        if (canvasRef.current) drawFrame(canvasRef.current, f);
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
      alive: () => fetch(`${location.origin}${location.pathname}`, { method: 'HEAD', cache: 'no-store' }).then((r) => r.status !== 404, () => true),
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
  }, []);

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
    setRing(field ? ringOver(field) : null);
    relift(); // the keyboard may already be open (another field was being typed into)
  };
  /** Where a field (or, for null, the mirror's bottom strip) sits over the mirror, in CSS px of the stage. */
  const canvasRect = () => {
    const cr = canvasRef.current!.getBoundingClientRect();
    const sr = stageRef.current!.getBoundingClientRect();
    return { left: cr.left - sr.left, top: cr.top - sr.top, width: cr.width, height: cr.height };
  };
  const boxOver = (field: Field | null): Box => bridgeBox(field, canvasRect(), pageSize.current);
  /** The outline: the field's exact box, with no minimum size. */
  const ringOver = (field: Field): Box => fieldBox(field, canvasRect(), pageSize.current);
  /** Moves the outline and the typing box over the field the page now focuses, keeping the keyboard open. */
  const placeOver = (field: Field) => {
    const el = bridgeRef.current;
    if (!el || !canvasRef.current || !stageRef.current) return;
    const box = boxOver(field);
    Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    bridgeBoxRef.current = box;
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

  const point = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current;
    return c ? toPagePoint({ x: e.clientX, y: e.clientY }, c.getBoundingClientRect(), pageSize.current) : null;
  };

  const onPointer = (action: 'down' | 'up') => (e: PointerEvent) => {
    if (!live) return;
    if (action === 'down') {
      const p = point(e);
      if (!p) return;
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      pressed.current = BUTTONS[e.button] ?? 'left';
      tapRef.current = { x: e.clientX, y: e.clientY, field: hitField(fieldsRef.current, p) };
      send({ t: 'mouse', action, ...p, button: pressed.current, clickCount: 1, modifiers: modifiersOf(e) });
      return;
    }
    release(e);
    // A tap (not a drag): open the right keyboard for the field under it, or close it elsewhere. Focusing on release
    // is what iOS honours most reliably, and a drag that starts on a field doesn't open the keyboard.
    const tap = tapRef.current;
    tapRef.current = null;
    if (!tap || Math.hypot(e.clientX - tap.x, e.clientY - tap.y) >= TAP_SLOP_PX) return;
    if (tap.field) openBridge(tap.field.kind, tap.field);
    // Only a keyboard a field tap opened closes on a tap elsewhere: the Keyboard button's stays (older engines send no
    // map, and fields the map can't see, like cross-origin frames, still need typing).
    else if (document.activeElement === bridgeRef.current && mappedTap.current) closeBridge();
  };

  /** Always pair a press with a release, even if the pointer ended in the letterbox or was cancelled. */
  const release = (e: PointerEvent) => {
    const button = pressed.current;
    const c = canvasRef.current;
    if (!button || !c) return;
    const p = clampToPage({ x: e.clientX, y: e.clientY }, c.getBoundingClientRect(), pageSize.current);
    if (!p) return;
    pressed.current = null;
    e.preventDefault();
    send({ t: 'mouse', action: 'up', ...p, button, clickCount: 1, modifiers: modifiersOf(e) });
  };

  const cancel = (e: PointerEvent) => {
    tapRef.current = null;
    release(e);
  };

  const scroll = (direction: 1 | -1) => {
    const { width, height } = pageSize.current;
    if (!live || width === 0) return;
    send({ t: 'wheel', x: width / 2, y: height / 2, dx: 0, dy: Math.round(direction * height * SCROLL_FRACTION) });
  };

  const onMove = (e: PointerEvent) => {
    if (moveQueued.current || !live) return;
    const p = point(e);
    if (!p) return;
    moveQueued.current = true;
    setTimeout(() => (moveQueued.current = false), 16);
    send({ t: 'mouse', action: 'move', ...p, button: e.buttons & 1 ? 'left' : 'none', clickCount: 0, modifiers: modifiersOf(e) });
  };

  const onWheel = (e: WheelEvent) => {
    const p = point(e);
    if (!p || !live) return;
    e.preventDefault();
    send({ t: 'wheel', ...p, dx: e.deltaX, dy: e.deltaY });
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const down = onPointer('down');
    const up = onPointer('up');
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
      setRing(null);
    };
    el.addEventListener('blur', unlift);
    return () => {
      detach();
      el.removeEventListener('blur', unlift);
    };
  }, [screen.kind]);

  // Keep the field in view: when the keyboard shrinks the visible area, lift the mirror so the field sits above it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => relift();
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [screen.kind]);

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

  return (
    <div class="app">
      <header class="topbar">
        <div class="topbar-text">
          <p class="reason">{info?.reason ?? 'Connecting to the agent…'}</p>
          {info?.site ? <p class="site">{info.site}</p> : null}
        </div>
        {info ? (
          <span class="countdown" data-testid="countdown" aria-label={`Time left ${remaining}`}>
            {remaining}
          </span>
        ) : null}
      </header>

      <div class="stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          data-testid="screen"
          class="screen"
          aria-label="Live view of the agent's browser. Tap or click to interact."
        />
        <div class="scroll-controls">
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
