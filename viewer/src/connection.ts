import { decodeFrame, type EngineToViewer, type Frame, type SessionStatus, type ViewerErrorCode, type ViewerToEngine } from '@unstuck/protocol';

export type Phase = 'connecting' | 'live' | 'reconnecting' | 'closed';
type Ready = Extract<EngineToViewer, { t: 'ready' }>;

export interface ConnectionHandlers {
  onReady(r: Ready): void;
  onFrame(f: Frame): void;
  onState(s: SessionStatus): void;
  onError(code: ViewerErrorCode, message: string): void;
  onPhase(p: Phase): void;
}

export interface ViewerSocket {
  send(m: ViewerToEngine): void;
  close(): void;
}

const BACKOFF_MS = [500, 1000, 2000, 4000];
const RESUME_WINDOW_MS = 60_000;
const PING_MS = 20_000;
const FATAL: ReadonlySet<ViewerErrorCode> = new Set(['token_invalid', 'token_used', 'expired', 'session_closed']);
const TERMINAL: ReadonlySet<SessionStatus> = new Set(['resolved', 'timed_out', 'cancelled', 'failed']);

export function connect(
  url: string,
  token: string,
  h: ConnectionHandlers,
  opts: { WebSocketImpl?: typeof WebSocket } = {},
): ViewerSocket {
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  let ws: WebSocket;
  let resumeKey: string | undefined;
  let stopped = false;
  let attempt = 0;
  let downSince: number | null = null;
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    ws = new WS(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(JSON.stringify(resumeKey ? { t: 'hello', token, resumeKey } : { t: 'hello', token }));
      ping = setInterval(() => ws.readyState === 1 && ws.send('{"t":"ping"}'), PING_MS);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (e.data instanceof ArrayBuffer) {
        const f = decodeFrame(new Uint8Array(e.data));
        if (f) h.onFrame(f);
        return;
      }
      let m: EngineToViewer;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.t === 'ready') {
        resumeKey = m.resumeKey;
        attempt = 0;
        downSince = null;
        h.onReady(m);
        h.onPhase('live');
      } else if (m.t === 'state') {
        if (TERMINAL.has(m.status)) stopped = true;
        h.onState(m.status);
      } else if (m.t === 'error') {
        if (FATAL.has(m.code)) stopped = true;
        h.onError(m.code, m.message);
      }
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (stopped) return;
      downSince ??= Date.now();
      if (Date.now() - downSince >= RESUME_WINDOW_MS) {
        stopped = true;
        h.onPhase('closed');
        return;
      }
      h.onPhase('reconnecting');
      retry = setTimeout(open, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
    };
  };

  h.onPhase('connecting');
  open();
  return {
    send(m) {
      if (ws.readyState === 1) ws.send(JSON.stringify(m));
    },
    close() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ping);
      ws.close();
    },
  };
}
