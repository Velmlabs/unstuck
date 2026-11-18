import { RESUME_WINDOW_MS, b64urlEncode, decodeFrame, padPlaintext, isJsonPlaintext, openMsg, sealMsg, type AskAnswer, type EngineToViewer, type Field, type FieldKind, type Frame, type SessionStatus, type ViewerErrorCode, type ViewerToEngine } from '@velmlabs/unstuck-protocol';

/** `closed`: gave up retrying; `ended`: the relay says the session no longer exists (no point retrying). */
export type Phase = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'ended';
type Ready = Extract<EngineToViewer, { t: 'ready' }>;

export interface ConnectionHandlers {
  onReady(r: Ready): void;
  onFrame(f: Frame): void;
  onState(s: SessionStatus, answer?: AskAnswer): void;
  onError(code: ViewerErrorCode, message: string): void;
  onPhase(p: Phase): void;
  /** The engine wants the 6-digit code (`invalid` after a wrong one). */
  onCodeRequest?(invalid: boolean): void;
  /** Native typing: where the typable fields are on the page (engine 0.1.3+). */
  onFields?(fields: Field[]): void;
  /** Native typing: what has focus after a tap or a key, and where it is (engine 0.1.3+). */
  onFocus?(kind: FieldKind | null, field?: Field): void;
  /** Approval and question sessions: which screen to show (never sent by older engines, so the live view stays). */
  onMode?(m: Extract<EngineToViewer, { t: 'mode' }>): void;
}

/**
 * End-to-end sealing for this session (relay spec §5.4). `conn` is the nonce from the engine's challenge ('' for the
 * challenge itself); `seq` must increase per direction, so a relay can't replay messages.
 */
export interface Codec {
  seal(conn: string, seq: number, plain: Uint8Array): Promise<Uint8Array>;
  open(conn: string, sealed: Uint8Array): Promise<{ seq: number; plain: Uint8Array } | null>;
}

export const e2eCodec = (key: CryptoKey, sessionId: string): Codec => ({
  seal: (conn, seq, p) => sealMsg(key, sessionId, 'v2e', conn, seq, p),
  open: (conn, b) => openMsg(key, sessionId, 'e2v', conn, b),
});

export interface ViewerSocket {
  send(m: ViewerToEngine): void;
  /** Send hello again, with the 6-digit code the human typed. */
  sendHello(code?: string): void;
  /** The page is visible again or the network is back: retry now instead of waiting out the backoff. */
  wake(): void;
  /**
   * Frame credit: `frame` has been drawn. Sends `{ t: 'ack', seq }` for a numbered frame from the current connection;
   * frames without a number (credit not negotiated) or from a socket since replaced are ignored.
   */
  ack(frame: Frame): void;
  close(): void;
}

const BACKOFF_MS = [500, 1000, 2000, 4000];
/** Characters per text message: at most 4 bytes each in UTF-8 (plus JSON escaping) stays well under 64 KB. */
const TEXT_CHUNK = 8_000;
/** Splits text into pieces of at most TEXT_CHUNK code points (never inside a surrogate pair). */
function chunks(text: string): string[] {
  const cps = [...text];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += TEXT_CHUNK) out.push(cps.slice(i, i + TEXT_CHUNK).join(''));
  return out;
}
const PING_MS = 20_000;
const FATAL: ReadonlySet<ViewerErrorCode> = new Set(['token_invalid', 'token_used', 'expired', 'session_closed']);
const TERMINAL: ReadonlySet<SessionStatus> = new Set(['resolved', 'answered', 'timed_out', 'cancelled', 'failed']);

export function connect(
  url: string,
  token: string,
  codec: Codec,
  h: ConnectionHandlers,
  opts: {
    WebSocketImpl?: typeof WebSocket;
    resumeKey?: string;
    /** Whether the session still exists (false: it has ended, stop retrying). Asked after a connection drops. */
    alive?: () => Promise<boolean>;
  } = {},
): ViewerSocket {
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  let ws: WebSocket;
  let resumeKey: string | undefined = opts.resumeKey;
  let stopped = false;
  let attempt = 0;
  let downSince: number | null = null;
  let ping: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  let outChain: Promise<void> = Promise.resolve();
  let inChain: Promise<void> = Promise.resolve();
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Per socket: the engine's challenge nonce and the sequence numbers in each direction.
  let nonce: string | null = null;
  let outSeq = 0;
  let lastIn = 0;
  // Anti-replay: with an engine that announces v: 2, our random vn must come back in ready before we trust anything.
  let vn: string | null = null;
  let verified = true;
  /** The socket each numbered frame came in on, so an ack never reaches a later connection. */
  const frameSocket = new WeakMap<Frame, WebSocket>();

  /** Seals and sends in order on the socket that was open when the message was queued. */
  const write = (target: WebSocket, m: ViewerToEngine) => {
    if (nonce === null) return; // nothing goes out before the engine's challenge
    const conn = nonce;
    const seq = ++outSeq;
    const plain = padPlaintext(enc.encode(JSON.stringify(m))); // sizes must not tell which key or how much text
    outChain = outChain
      .then(async () => {
        const sealed = await codec.seal(conn, seq, plain);
        if (target.readyState === 1 && target === ws) target.send(sealed);
      })
      .catch(() => {});
  };
  const hello = (target: WebSocket, code?: string) =>
    write(target, { t: 'hello', token, ...(resumeKey ? { resumeKey } : {}), ...(code ? { code } : {}), ...(vn ? { vn } : {}) } as ViewerToEngine);

  const handle = (m: EngineToViewer, socket: WebSocket) => {
    if (!verified) {
      // Until our vn comes back, anything but an error may be a replay of an old connection.
      if (m.t === 'ready' && m.vn === vn) verified = true;
      else if (m.t === 'ready') return void socket.close();
      else if (m.t !== 'error') return;
    }
    if (m.t === 'ready') {
      // Frame credit is opt-in: only an engine that announces it accepts these messages (older ones refuse unknown ones).
      if (m.credit === 1) write(socket, { t: 'credit', v: 1 });
      resumeKey = m.resumeKey;
      attempt = 0;
      downSince = null;
      h.onReady(m);
      h.onPhase('live');
    } else if (m.t === 'state') {
      if (TERMINAL.has(m.status)) stopped = true;
      if (m.answer) h.onState(m.status, m.answer);
      else h.onState(m.status);
    } else if (m.t === 'error') {
      if (m.code === 'code_required' || m.code === 'code_invalid') return h.onCodeRequest?.(m.code === 'code_invalid');
      if (FATAL.has(m.code)) stopped = true;
      h.onError(m.code, m.message);
    } else if (m.t === 'fields') h.onFields?.(m.fields);
    else if (m.t === 'focus') h.onFocus?.(m.kind, m.field);
    else if (m.t === 'mode') h.onMode?.(m);
  };

  const open = () => {
    ws = new WS(url);
    ws.binaryType = 'arraybuffer';
    const socket = ws;
    nonce = null;
    outSeq = 0;
    lastIn = 0;
    vn = null;
    verified = true;
    ws.onopen = () => {
      ping = setInterval(() => socket.readyState === 1 && write(socket, { t: 'ping' }), PING_MS);
    };
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') return; // everything from the engine is sealed binary (binaryType arraybuffer)
      const bytes = new Uint8Array(e.data as ArrayBuffer);
      inChain = inChain.then(async () => {
        if (socket !== ws) return; // from a socket we've replaced
        if (nonce === null) {
          // The first message on every connection is the engine's challenge: hello only after it.
          const c = await codec.open('', bytes);
          if (!c || socket !== ws) return;
          try {
            const m = JSON.parse(dec.decode(c.plain)) as { t?: string; n?: unknown; v?: unknown };
            if (m.t !== 'challenge' || typeof m.n !== 'string') return;
            nonce = m.n;
            if (m.v === 2) {
              vn = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
              verified = false;
            }
          } catch {
            return;
          }
          return hello(socket);
        }
        const msg = await codec.open(nonce, bytes);
        if (!msg || socket !== ws || msg.seq <= lastIn) return; // not ours, or a replay
        lastIn = msg.seq;
        const plain = msg.plain;
        if (!isJsonPlaintext(plain)) {
          if (!verified) return;
          const f = decodeFrame(plain);
          if (!f) return;
          if (f.seq !== undefined) frameSocket.set(f, socket);
          h.onFrame(f);
          return;
        }
        let m: EngineToViewer;
        try {
          m = JSON.parse(dec.decode(plain));
        } catch {
          return;
        }
        handle(m, socket);
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
      checkAlive();
    };
  };

  /** A reconnect can't tell "session over" from "network down" (browsers hide the upgrade's 404): ask the relay. */
  const checkAlive = () => {
    if (!opts.alive || checking) return;
    checking = true;
    void opts.alive().then(
      (alive) => {
        checking = false;
        if (alive || stopped) return;
        stopped = true;
        clearTimeout(retry);
        h.onPhase('ended');
      },
      () => void (checking = false),
    );
  };

  h.onPhase('connecting');
  open();
  return {
    send(m) {
      if (ws.readyState !== 1) return;
      // A long paste goes in pieces, each within the relay's 64 KB message limit once sealed.
      if (m.t === 'text' && m.text.length > TEXT_CHUNK) for (const part of chunks(m.text)) write(ws, { t: 'text', text: part });
      else write(ws, m);
    },
    sendHello(code) {
      if (ws.readyState === 1) hello(ws, code);
    },
    ack(frame) {
      if (frame.seq === undefined || frameSocket.get(frame) !== ws || ws.readyState !== 1) return;
      write(ws, { t: 'ack', seq: frame.seq });
    },
    wake() {
      if (stopped || downSince === null || ws.readyState === 0 || ws.readyState === 1) return;
      clearTimeout(retry);
      open();
    },
    close() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(ping);
      ws.close();
    },
  };
}
