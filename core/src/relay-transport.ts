import {
  b64urlEncode,
  decodeEnvelope,
  encodeEnvelope,
  KEY_SUBPROTOCOL_PREFIX,
  parseRelayToAgent,
  RELAY_CLOSE,
  RELAY_SUBPROTOCOL,
} from '@unstuck/protocol';
import type { Transport, ViewerConnection } from './transport';

export type RelayErrorDetail = 'relay_unauthorized' | 'relay_quota_exceeded' | 'relay_rate_limited' | 'relay_unreachable';

/** Why a relay refused or couldn't be reached; the session turns `detail` into a failed result. */
export class RelayError extends Error {
  constructor(
    readonly detail: RelayErrorDetail,
    /** The WebSocket close code the relay used, when it closed us. */
    readonly closeCode?: number,
  ) {
    super(detail);
    this.name = 'RelayError';
  }
}

export interface RelayTransportOptions {
  /** wss://host (or ws:// for local testing). */
  url: string;
  agentKey?: string;
  WebSocketImpl?: typeof WebSocket;
  connectTimeoutMs?: number;
}

const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;

function detailFor(code: number): RelayErrorDetail {
  if (code === RELAY_CLOSE.refused(401) || code === RELAY_CLOSE.refused(403)) return 'relay_unauthorized';
  if (code === RELAY_CLOSE.refused(402)) return 'relay_quota_exceeded';
  if (code === RELAY_CLOSE.refused(429)) return 'relay_rate_limited';
  return 'relay_unreachable';
}

interface Conn {
  messages: ((d: string | Uint8Array) => void)[];
  closes: (() => void)[];
  closed: boolean;
}

interface Session {
  id: string;
  secret: string;
  expiresAt: number;
  ws: WebSocket | null;
  handler: ((c: ViewerConnection) => void) | null;
  status: ((s: 'up' | 'down') => void) | null;
  conns: Map<number, Conn>;
  registered: boolean;
  everRegistered: boolean;
  attempt: number;
  retry: ReturnType<typeof setTimeout> | null;
  gone: boolean;
}

/** The engine side of a relay (relay spec §5.6): one agent socket per takeover, viewers multiplexed on it. */
export function createRelayTransport(opts: RelayTransportOptions): Transport & { onStatus(id: string, h: (s: 'up' | 'down') => void): void } {
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
  const relay = opts.url.replace(/\/+$/, '');
  const httpBase = relay.replace(/^ws/, 'http');
  const protocols = [RELAY_SUBPROTOCOL, ...(opts.agentKey ? [KEY_SUBPROTOCOL_PREFIX + opts.agentKey] : [])];
  const timeoutMs = opts.connectTimeoutMs ?? 15_000;
  const sessions = new Map<string, Session>();
  const enc = new TextEncoder();

  const closeConn = (s: Session, c: number) => {
    const conn = s.conns.get(c);
    if (!conn || conn.closed) return;
    conn.closed = true;
    s.conns.delete(c);
    for (const h of conn.closes) h();
  };

  const viewerConnection = (s: Session, ws: WebSocket, c: number, conn: Conn): ViewerConnection => ({
    send(d) {
      if (!conn.closed && ws.readyState === 1) ws.send(encodeEnvelope(c, typeof d === 'string' ? enc.encode(d) : d));
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    onMessage: (h) => void conn.messages.push(h),
    onClose: (h) => void conn.closes.push(h),
    close(code = 1000) {
      if (conn.closed) return;
      if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'close', c, code }));
      closeConn(s, c);
    },
  });

  /** Opens the agent socket; resolves on `registered`, rejects with the relay's reason otherwise. */
  const connect = (s: Session): Promise<void> =>
    new Promise((resolve, reject) => {
      const ws = new WS(`${relay}/agent/${s.id}`, protocols);
      ws.binaryType = 'arraybuffer';
      s.ws = ws;
      let registered = false;
      const timer = setTimeout(() => {
        ws.onclose = null;
        ws.close();
        reject(new RelayError('relay_unreachable'));
      }, timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', expiresAt: s.expiresAt, secret: s.secret }));
      ws.onmessage = (e: MessageEvent) => {
        if (typeof e.data !== 'string') {
          const env = decodeEnvelope(new Uint8Array(e.data as ArrayBuffer));
          const conn = env && s.conns.get(env.c);
          if (conn) for (const h of conn.messages) h(env.payload);
          return;
        }
        const m = parseRelayToAgent(e.data);
        if (!m) return;
        if (m.t === 'registered') {
          if (registered) return;
          registered = true;
          clearTimeout(timer);
          if (s.everRegistered) {
            s.attempt = 0;
            s.registered = true;
            s.status?.('up');
          }
          s.everRegistered = true;
          s.registered = true;
          resolve();
        } else if (m.t === 'ping') ws.send('{"t":"pong"}');
        else if (m.t === 'close') closeConn(s, m.c);
        else {
          const conn: Conn = { messages: [], closes: [], closed: false };
          s.conns.set(m.c, conn);
          const vc = viewerConnection(s, ws, m.c, conn);
          if (s.handler) s.handler(vc);
          else vc.close(1013);
        }
      };
      ws.onclose = (e: CloseEvent) => {
        clearTimeout(timer);
        for (const c of [...s.conns.keys()]) closeConn(s, c);
        if (!registered) return reject(new RelayError(detailFor(e.code), e.code));
        onDrop(s, e.code);
      };
    });

  const onDrop = (s: Session, code: number) => {
    if (s.gone) return;
    s.registered = false;
    s.status?.('down');
    if (code === RELAY_CLOSE.replaced) return; // the relay gave this session to someone else: don't fight it
    scheduleReconnect(s);
  };

  const scheduleReconnect = (s: Session) => {
    if (s.gone) return;
    const delay = Math.min(BACKOFF_START_MS * 2 ** s.attempt++, BACKOFF_MAX_MS);
    s.retry = setTimeout(() => {
      s.retry = null;
      connect(s).catch((e: RelayError) => {
        if (e.closeCode !== RELAY_CLOSE.replaced) scheduleReconnect(s); // 4409: the session is someone else's now
      });
    }, delay);
  };

  const unpublish = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.gone = true;
    if (s.retry) clearTimeout(s.retry);
    const ws = s.ws;
    if (ws && ws.readyState === 1) {
      ws.send('{"t":"end"}');
      ws.onclose = null;
      ws.close(1000);
    }
  };

  return {
    async publish(id, { expiresAt }) {
      const s: Session = {
        id,
        secret: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
        expiresAt,
        ws: null,
        handler: null,
        status: null,
        conns: new Map(),
        registered: false,
        everRegistered: false,
        attempt: 0,
        retry: null,
        gone: false,
      };
      sessions.set(id, s);
      try {
        await connect(s);
      } catch (e) {
        sessions.delete(id);
        throw e;
      }
      return { baseUrl: `${httpBase}/s/${id}` };
    },
    onConnection(id, h) {
      const s = sessions.get(id);
      if (s) s.handler = h;
    },
    onStatus(id, h) {
      const s = sessions.get(id);
      if (s) s.status = h;
    },
    unpublish,
    async close() {
      await Promise.all([...sessions.keys()].map(unpublish));
    },
  };
}
