import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { KEY_SUBPROTOCOL_PREFIX, RELAY_CLOSE, RELAY_LIMITS, RELAY_SUBPROTOCOL, SESSION_ID_RE } from '@velmlabs/unstuck-protocol';
import { createRateLimiter, hashKey, newRecord, refusalReason, RelaySession, type Authorize, type OnEvent, type RelaySocket } from '@velmlabs/unstuck-relay-core';

export interface NodeRelayOptions {
  port?: number;
  host?: string;
  /** The viewer's build output (index.html + assets/). */
  viewerDir: string;
  authorize: Authorize;
  onEvent?: OnEvent;
  now?: () => number;
  /** Housekeeping interval (spec §5.9). */
  sweepMs?: number;
  /**
   * Take the client IP from X-Forwarded-For (only behind a proxy you trust). `true` or a number of trusted
   * proxies N (default 1): the client is the Nth entry from the right, the one your outermost proxy appended.
   * Entries further left are whatever the client sent.
   */
  trustProxy?: boolean | number;
  /** Send `strict-transport-security` (only when clients reach this relay over https, e.g. behind a TLS proxy). */
  hsts?: boolean;
  /** Called on every accepted agent connection (the CLI warns in open mode). */
  onAgent?: () => void;
}

export interface NodeRelay {
  port: number;
  close(): Promise<void>;
  stats(): { sessions: number; limiterBuckets: number };
}

const CSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const EXPIRED_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const HSTS = 'max-age=31536000';
const EXPIRED_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unstuck</title></head><body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#0f172a;color:#e2e8f0"><main style="text-align:center;padding:16px"><h1 style="font-size:20px">This link has expired or is invalid</h1><p>The takeover already finished or timed out. You can close this tab.</p></main></body></html>';
const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const toSocket = (ws: WebSocket): RelaySocket => ({
  send: (d) => ws.readyState === ws.OPEN && ws.send(d, { binary: typeof d !== 'string' }),
  close: (code, reason) => ws.close(code, reason), // relay-core guards this (safeClose)
  get bufferedAmount() {
    return ws.bufferedAmount;
  },
});
const payload = (data: Buffer, isBinary: boolean): string | Uint8Array => (isBinary ? new Uint8Array(data) : data.toString('utf8'));

/** Self-hosted relay (spec §5): one RelaySession per takeover, in memory. */
export async function createNodeRelay(opts: NodeRelayOptions): Promise<NodeRelay> {
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, RelaySession>();
  const viewerLimit = createRateLimiter(RELAY_LIMITS.viewerUpgradesPerMinPerIp, 60_000, now);
  const agentLimit = createRateLimiter(RELAY_LIMITS.agentUpgradesPerMinPerKey, 60_000, now);
  // Key brute force: refused authorizations per client IP, whatever key each one presented.
  const agentFailLimit = createRateLimiter(RELAY_LIMITS.agentAuthFailuresPerMinPerIp, 60_000, now);
  const hops = opts.trustProxy === true ? 1 : typeof opts.trustProxy === 'number' && opts.trustProxy >= 1 ? Math.floor(opts.trustProxy) : 0;
  const onEvent: OnEvent = (e) => opts.onEvent?.(e);
  const viewerDir = path.resolve(opts.viewerDir);
  const index = await fs.readFile(path.join(viewerDir, 'index.html'));

  // One timer per session at its next deadline (expiry, grace, heartbeat, idle); the sweep is only a backstop.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedule = (id: string) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    const s = sessions.get(id);
    if (!s) return;
    if (s.ended) return void sessions.delete(id);
    const t = setTimeout(() => {
      timers.delete(id);
      if (s.tick() === 'ended') sessions.delete(id);
      else schedule(id);
    }, Math.max(0, s.deadline() - now()));
    t.unref();
    timers.set(id, t);
  };

  const live = (id: string) => {
    const s = sessions.get(id);
    return s && !s.ended && s.record.secretHash !== null ? s : undefined;
  };
  const forget = (id: string) => schedule(id);
  const forwardedFor = (req: http.IncomingMessage): string | undefined => {
    if (!hops) return undefined;
    const xs = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return xs[Math.max(0, xs.length - hops)];
  };
  const ipOf = (req: http.IncomingMessage) => forwardedFor(req) || req.socket.remoteAddress || 'unknown';

  const server = http.createServer((req, res) => {
    if (opts.hsts) res.setHeader('strict-transport-security', HSTS);
    // Never let one request take the relay (and every live takeover) down.
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<unknown> {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (p === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    const sess = /^\/s\/([^/]+)$/.exec(p);
    if (sess) {
      const ok = SESSION_ID_RE.test(sess[1]!) && live(sess[1]!);
      res.writeHead(ok ? 200 : 404, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': ok ? CSP : EXPIRED_CSP,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        // A viewer on its own origin checks whether the session still exists (status only; no credentials).
        'access-control-allow-origin': '*',
      });
      return res.end(ok ? index : EXPIRED_HTML);
    }
    if (p.startsWith('/assets/')) {
      let decoded: string | null = null;
      try {
        decoded = decodeURIComponent(p);
      } catch {
        // malformed escape: not an asset
      }
      const file = decoded === null ? '' : path.resolve(viewerDir, '.' + decoded);
      if (decoded !== null && file.startsWith(path.join(viewerDir, 'assets') + path.sep)) {
        const body = await fs.readFile(file).catch(() => null);
        if (body) {
          res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
          return res.end(body);
        }
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: RELAY_LIMITS.agentPayloadMax + 4,
    handleProtocols: (protocols) => (protocols.has(RELAY_SUBPROTOCOL) ? RELAY_SUBPROTOCOL : false),
  });
  // Viewers get their own server so ws refuses (1009) anything over 64 KB before buffering it.
  const viewerWss = new WebSocketServer({ noServer: true, maxPayload: RELAY_LIMITS.viewerPayloadMax });
  const refuseHttp = (socket: Duplex, status: number, text: string) =>
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n${opts.hsts ? `Strict-Transport-Security: ${HSTS}\r\n` : ''}Content-Length: 0\r\n\r\n`);

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    onUpgrade(req, socket, head).catch(() => socket.destroy());
  });

  async function onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<unknown> {
    const m = /^\/(agent|ws)\/([^/]+)$/.exec(new URL(req.url ?? '/', 'http://x').pathname);
    if (!m || !SESSION_ID_RE.test(m[2]!)) return refuseHttp(socket, 404, 'Not Found');
    const [, kind, id] = m as unknown as [string, 'agent' | 'ws', string];

    const ip = ipOf(req);
    if (kind === 'ws') {
      if (!viewerLimit.take(ip)) return refuseHttp(socket, 429, 'Too Many Requests');
      const s = live(id);
      if (!s) return refuseHttp(socket, 404, 'Not Found');
      return viewerWss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => ws.terminate()); // bad UTF-8, reset: drop this socket only (oversize: ws already closed it with 1009)
        const c = s.attachViewer(toSocket(ws), ip);
        if (c === null) return ws.close(RELAY_CLOSE.tryAgainLater, 'try again later');
        schedule(id);
        ws.on('message', (data: Buffer, isBinary: boolean) => s.viewerMessage(c, payload(data, isBinary)));
        ws.on('close', () => (s.viewerClosed(c), schedule(id)));
      });
    }

    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((x) => x.trim());
    const key = offered.find((p) => p.startsWith(KEY_SUBPROTOCOL_PREFIX))?.slice(KEY_SUBPROTOCOL_PREFIX.length) ?? null;
    const keyHash = await hashKey(key ?? '');
    const verdict = await (async (): ReturnType<Authorize> => {
      // An IP over its failure budget is refused before authorizing, so it learns nothing about any key.
      if (!agentFailLimit.allowed(ip) || !agentLimit.take(keyHash)) return { ok: false, status: 429, error: 'rate_limited' };
      const v = await opts.authorize(key, { sessionId: id, ip }).catch(() => ({ ok: false, status: 403, error: 'authorize_failed' }) as const);
      if (!v.ok) agentFailLimit.take(ip);
      return v;
    })();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => ws.terminate());
      // Refusals are delivered as close codes (4000 + status): WebSocket clients can't read an upgrade's HTTP status.
      if (!verdict.ok) return ws.close(RELAY_CLOSE.refused(verdict.status), refusalReason(verdict.error));
      let s = sessions.get(id);
      if (s?.ended) (sessions.delete(id), (s = undefined));
      if (s && s.record.keyHash !== keyHash) return ws.close(RELAY_CLOSE.replaced, 'session belongs to another key');
      if (!s) sessions.set(id, (s = new RelaySession(newRecord(id, verdict.account, keyHash, now()), onEvent, now)));
      const session = s;
      opts.onAgent?.();
      const rs = toSocket(ws);
      session.attachAgent(rs);
      schedule(id);
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        session.agentMessage(rs, payload(data, isBinary));
        void session.flush().then(() => forget(id));
      });
      ws.on('close', () => (session.agentClosed(rs), schedule(id)));
    });
  }

  // Housekeeping (spec §5.9): tick every session, drop ended ones and sessions that never registered.
  const sweep = setInterval(() => {
    const t = now();
    for (const [id, s] of sessions) {
      if (s.tick() === 'ended') sessions.delete(id);
      else schedule(id);
    }
    viewerLimit.prune();
    agentLimit.prune();
    agentFailLimit.prune();
  }, opts.sweepMs ?? 60_000);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8787, opts.host ?? '0.0.0.0', () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    stats: () => ({ sessions: sessions.size, limiterBuckets: viewerLimit.size() + agentLimit.size() + agentFailLimit.size() }),
    async close() {
      clearInterval(sweep);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const ws of [...wss.clients, ...viewerWss.clients]) ws.close(1001, 'relay shutting down');
      for (const s of sessions.values()) s.end('shutdown');
      sessions.clear();
      const forced = setTimeout(() => {
        for (const ws of [...wss.clients, ...viewerWss.clients]) ws.terminate();
        server.closeAllConnections();
      }, 4000);
      await new Promise<void>((r) => server.close(() => r()));
      clearTimeout(forced);
    },
  };
}
