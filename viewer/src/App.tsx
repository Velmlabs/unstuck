import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import type { Frame, SessionStatus, ViewerErrorCode, ViewerToEngine } from '@unstuck/protocol';
import { connect as defaultConnect, type ConnectionHandlers, type Phase, type ViewerSocket } from './connection';
import { drawFrameOnCanvas } from './draw';
import { keyEventToMessage, modifiersOf } from './keys';
import { toPagePoint } from './mapping';
import { parseFragment, sessionIdFromPath, wsUrlFor } from './url';

export interface AppProps {
  location: { hash: string; pathname: string; origin: string };
  connectFn?: (url: string, token: string, h: ConnectionHandlers) => ViewerSocket;
  drawFrame?: (canvas: HTMLCanvasElement, frame: Frame) => void;
  now?: () => number;
}

type Screen =
  | { kind: 'session' }
  | { kind: 'message'; title: string; body: string; tone: 'ok' | 'warn' | 'error' };

const ERROR_SCREENS: Record<Exclude<ViewerErrorCode, 'bad_message'>, Screen> = {
  token_invalid: { kind: 'message', title: 'This link is not valid', body: 'Ask for a new link from the person or agent that sent it.', tone: 'error' },
  token_used: { kind: 'message', title: 'This link is already in use', body: 'Someone else opened this takeover first. Only one person can control the browser at a time.', tone: 'warn' },
  expired: { kind: 'message', title: 'This link has expired', body: 'The takeover window closed before anyone joined.', tone: 'warn' },
  session_closed: { kind: 'message', title: 'This takeover has ended', body: 'You can close this tab.', tone: 'ok' },
};

const FINAL_SCREENS: Partial<Record<SessionStatus, Screen>> = {
  resolved: { kind: 'message', title: 'All done, thank you', body: 'Control is back with the agent. You can close this tab.', tone: 'ok' },
  cancelled: { kind: 'message', title: 'Handed back to the agent', body: 'The agent knows this one could not be solved. You can close this tab.', tone: 'warn' },
  timed_out: { kind: 'message', title: 'Time ran out', body: 'The takeover window closed. The agent will decide what to do next.', tone: 'warn' },
  failed: { kind: 'message', title: 'The page closed or something went wrong', body: 'The agent will be told. You can close this tab.', tone: 'error' },
};

const BUTTONS: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' };

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function App({ location, connectFn = defaultConnect, drawFrame = drawFrameOnCanvas, now = Date.now }: AppProps) {
  const token = parseFragment(location.hash)?.token;
  const sessionId = sessionIdFromPath(location.pathname);
  const [screen, setScreen] = useState<Screen>(token && sessionId ? { kind: 'session' } : ERROR_SCREENS.token_invalid);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [info, setInfo] = useState<{ reason: string; site: string; expiresAt: number } | null>(null);
  const [remaining, setRemaining] = useState('');
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bridgeRef = useRef<HTMLInputElement>(null);
  const sockRef = useRef<ViewerSocket | null>(null);
  const pageSize = useRef({ width: 0, height: 0 });
  const moveQueued = useRef(false);
  const live = screen.kind === 'session' && phase === 'live';
  const liveRef = useRef(live);
  liveRef.current = live && !asking;

  const send = useCallback((m: ViewerToEngine) => sockRef.current?.send(m), []);

  useEffect(() => {
    if (!token || !sessionId) return;
    const sock = connectFn(wsUrlFor(location.origin, sessionId), token, {
      onReady: (r) => setInfo({ reason: r.reason, site: r.site, expiresAt: r.expiresAt }),
      onFrame: (f) => {
        pageSize.current = { width: f.width, height: f.height };
        if (canvasRef.current) drawFrame(canvasRef.current, f);
      },
      onState: (s) => {
        const final = FINAL_SCREENS[s];
        if (final) {
          setScreen(final);
          sockRef.current?.close();
        }
      },
      onError: (code) => {
        if (code !== 'bad_message') setScreen(ERROR_SCREENS[code]);
      },
      onPhase: (p) => {
        setPhase(p);
        if (p === 'closed')
          setScreen({ kind: 'message', title: 'Connection lost', body: 'Reopen the link to try again while the takeover is still open.', tone: 'error' });
      },
    });
    sockRef.current = sock;
    return () => sock.close();
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
      if (!liveRef.current) return;
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

  const point = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current;
    return c ? toPagePoint({ x: e.clientX, y: e.clientY }, c.getBoundingClientRect(), pageSize.current) : null;
  };

  const onPointer = (action: 'down' | 'up') => (e: PointerEvent) => {
    const p = point(e);
    if (!p || !live) return;
    e.preventDefault();
    if (action === 'down') (e.target as Element).setPointerCapture?.(e.pointerId);
    send({ t: 'mouse', action, ...p, button: BUTTONS[e.button] ?? 'left', clickCount: 1, modifiers: modifiersOf(e) });
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

  const keyTap = (key: string, text?: string) => {
    send({ t: 'key', action: 'down', key, code: key, ...(text ? { text } : {}), modifiers: 0 });
    send({ t: 'key', action: 'up', key, code: key, modifiers: 0 });
  };

  const onBeforeInput = (e: InputEvent) => {
    if (e.inputType === 'insertCompositionText') return;
    e.preventDefault();
    if (e.inputType === 'insertText' && e.data) send({ t: 'text', text: e.data });
    else if (e.inputType === 'deleteContentBackward') keyTap('Backspace');
    else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') keyTap('Enter', '\r');
  };

  const onCompositionEnd = (e: CompositionEvent) => {
    if (e.data) send({ t: 'text', text: e.data });
    if (bridgeRef.current) bridgeRef.current.value = '';
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
    c.addEventListener('wheel', onWheel, { passive: false });
    c.addEventListener('contextmenu', noMenu);
    return () => {
      c.removeEventListener('pointerdown', down);
      c.removeEventListener('pointerup', up);
      c.removeEventListener('pointermove', onMove);
      c.removeEventListener('wheel', onWheel);
      c.removeEventListener('contextmenu', noMenu);
    };
  });

  useEffect(() => {
    const el = bridgeRef.current;
    if (!el) return;
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('compositionend', onCompositionEnd);
    return () => {
      el.removeEventListener('beforeinput', onBeforeInput);
      el.removeEventListener('compositionend', onCompositionEnd);
    };
  });

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

      <div class="stage">
        <canvas
          ref={canvasRef}
          data-testid="screen"
          class="screen"
          aria-label="Live view of the agent's browser. Tap or click to interact."
        />
        {phase !== 'live' ? (
          <div class="banner" role="status">
            {phase === 'reconnecting' ? 'Connection dropped. Reconnecting…' : 'Connecting…'}
          </div>
        ) : null}
      </div>

      <input
        ref={bridgeRef}
        data-testid="keyboard-bridge"
        class="keyboard-bridge"
        aria-label="Type into the agent's page"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
      />

      <footer class="bottombar">
        <button type="button" class="btn btn-ghost" onClick={() => bridgeRef.current?.focus()}>
          Keyboard
        </button>
        <button type="button" class="btn btn-secondary" onClick={() => setAsking(true)}>
          Can't solve
        </button>
        <button type="button" class="btn btn-primary" onClick={() => send({ t: 'done' })}>
          Done
        </button>
      </footer>

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
