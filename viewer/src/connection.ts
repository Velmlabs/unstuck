import { decodeFrame, isJsonPlaintext, open, seal, type EngineToViewer, type Frame, type SessionStatus, type ViewerErrorCode, type ViewerToEngine } from '@unstuck/protocol';

export type Phase = 'connecting' | 'live' | 'reconnecting' | 'closed';
type Ready = Extract<EngineToViewer, { t: 'ready' }>;

export interface ConnectionHandlers {
  onReady(r: Ready): void;
  onFrame(f: Frame): void;
  onState(s: SessionStatus): void;
  onError(code: ViewerErrorCode, message: string): void;
  onPhase(p: Phase): void;
  /** The engine wants the 6-digit code (`invalid` after a wrong one). */
  onCodeRequest?(invalid: boolean): void;
}

/** End-to-end sealing for this session (relay spec §5.4). */
export interface Codec {
  seal(plain: Uint8Array): Promise<Uint8Array>;
  open(sealed: Uint8Array): Promise<Uint8Array | null>;
}

export const e2eCodec = (key: CryptoKey, sessionId: string): Codec => ({
  seal: (p) => seal(key, sessionId, 'v2e', p),
  open: (b) => open(key, sessionId, 'e2v', b),
});

export interface ViewerSocket {
  send(m: ViewerToEngine): void;
  /** Send hello again, with the 6-digit code the human typed. */
  sendHello(code?: string): void;
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
  codec: Codec,
  h: ConnectionHandlers,
  opts: { WebSocketImpl?: typeof WebSocket; resumeKey?: string } = {},
): ViewerSocket {
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  let ws: WebSocket;
  let resumeKey: string | undefined = opts.resumeKey;
  let stopped = false;
  let attempt = 0;
  let downSince: number | null = null;
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let outChain: Promise<void> = Promise.resolve();
  let inChain: Promise<void> = Promise.resolve();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /** Seals and sends in order on the socket that was open when the message was queued. */
  const write = (target: WebSocket, m: ViewerToEngine) => {
    const plain = enc.encode(JSON.stringify(m));
    outChain = outChain.then(async () => {
      const sealed = await codec.seal(plain);
      if (target.readyState === 1) target.send(sealed);
    });
  };
  const hello = (target: WebSocket, code?: string) =>
    write(target, { t: 'hello', token, ...(resumeKey ? { resumeKey } : {}), ...(code ? { code } : {}) } as ViewerToEngine);

  const handle = (m: EngineToViewer) => {
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
      if (m.code === 'code_required' || m.code === 'code_invalid') return h.onCodeRequest?.(m.code === 'code_invalid');
      if (FATAL.has(m.code)) stopped = true;
      h.onError(m.code, m.message);
    }
  };

  const open = () => {
    ws = new WS(url);
    ws.binaryType = 'arraybuffer';
    const socket = ws;
    ws.onopen = () => {
      hello(socket);
      ping = setInterval(() => socket.readyState === 1 && write(socket, { t: 'ping' }), PING_MS);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') return; // everything from the engine is sealed binary (binaryType arraybuffer)
      const bytes = new Uint8Array(e.data as ArrayBuffer);
      inChain = inChain.then(async () => {
        const plain = await codec.open(bytes);
        if (!plain || socket !== ws) return; // not for us (wrong key) or from a socket we've replaced
        if (!isJsonPlaintext(plain)) {
          const f = decodeFrame(plain);
          if (f) h.onFrame(f);
          return;
        }
        let m: EngineToViewer;
        try {
          m = JSON.parse(dec.decode(plain));
        } catch {
          return;
        }
        handle(m);
      });
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
      if (ws.readyState === 1) write(ws, m);
    },
    sendHello(code) {
      if (ws.readyState === 1) hello(ws, code);
    },
    close() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ping);
      ws.close();
    },
  };
}
