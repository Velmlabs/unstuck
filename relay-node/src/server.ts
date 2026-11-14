import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { KEY_SUBPROTOCOL_PREFIX, RELAY_CLOSE, RELAY_LIMITS, RELAY_SUBPROTOCOL, SESSION_ID_RE } from '@velmlabs/unstuck-protocol';
import { createRateLimiter, hashKey, newRecord, RelaySession, type Authorize, type OnEvent, type RelaySocket } from '@velmlabs/unstuck-relay-core';

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
  /** Take the client IP from X-Forwarded-For (only behind a proxy you trust). */
  trustProxy?: boolean;
  /** Called on every accepted agent connection (the CLI warns in open mode). */
  onAgent?: () => void;
}

export interface NodeRelay {
  port: number;
  close(): Promise<void>;
  stats(): { sessions: number; limiterBuckets: number };
}

const CSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'";
const EXPIRED_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unstuck</title></head><body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#0f172a;color:#e2e8f0"><main style="text-align:center;padding:16px"><h1 style="font-size:20px">This link has expired or is invalid</h1><p>The takeover already finished or timed out. You can close this tab.</p></main></body></html>';
const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const toSocket = (ws: WebSocket): RelaySocket => ({
  send: (d) => ws.readyState === ws.OPEN && ws.send(d, { binary: typeof d !== 'string' }),
  close: (code, reason) => ws.close(code, reason),
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
  const ipOf = (req: http.IncomingMessage) =>
    (opts.trustProxy && String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim()) || req.socket.remoteAddress || 'unknown';

  const server = http.createServer((req, res) => {
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
        'content-security-policy': ok ? CSP : "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
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
  const refuseHttp = (socket: Duplex, status: number, text: string) =>
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    onUpgrade(req, socket, head).catch(() => socket.destroy());
  });

  async function onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<unknown> {
    const m = /^\/(agent|ws)\/([^/]+)$/.exec(new URL(req.url ?? '/', 'http://x').pathname);
    if (!m || !SESSION_ID_RE.test(m[2]!)) return refuseHttp(socket, 404, 'Not Found');
    const [, kind, id] = m as unknown as [string, 'agent' | 'ws', string];

    if (kind === 'ws') {
      if (!viewerLimit.take(ipOf(req))) return refuseHttp(socket, 429, 'Too Many Requests');
      const s = live(id);
      if (!s) return refuseHttp(socket, 404, 'Not Found');
      return wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => ws.terminate()); // oversize frame, bad UTF-8, reset: drop this socket only
        const c = s.attachViewer(toSocket(ws));
        if (c === null) return ws.close(1013, 'try again later');
        schedule(id);
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (data.length > RELAY_LIMITS.viewerPayloadMax) return ws.close(RELAY_CLOSE.tooBig, 'too big');
          s.viewerMessage(c, payload(data, isBinary));
        });
        ws.on('close', () => (s.viewerClosed(c), schedule(id)));
      });
    }

    const offered = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((x) => x.trim());
    const key = offered.find((p) => p.startsWith(KEY_SUBPROTOCOL_PREFIX))?.slice(KEY_SUBPROTOCOL_PREFIX.length) ?? null;
    const keyHash = await hashKey(key ?? '');
    const verdict = !agentLimit.take(keyHash)
      ? ({ ok: false, status: 429, error: 'rate_limited' } as const)
      : await opts.authorize(key, { sessionId: id, ip: ipOf(req) }).catch(() => ({ ok: false, status: 403, error: 'authorize_failed' }) as const);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => ws.terminate());
      // Refusals are delivered as close codes (4000 + status): WebSocket clients can't read an upgrade's HTTP status.
      if (!verdict.ok) return ws.close(RELAY_CLOSE.refused(verdict.status), JSON.stringify({ error: verdict.error }));
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
      if (s.record.secretHash === null && t - s.record.createdAt >= RELAY_LIMITS.heartbeatMs) s.end('never_registered');
      if (s.tick() === 'ended') sessions.delete(id);
      else schedule(id);
    }
    viewerLimit.prune();
    agentLimit.prune();
  }, opts.sweepMs ?? 60_000);
  sweep.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8787, opts.host ?? '0.0.0.0', () => resolve());
  });

  return {
    port: (server.address() as AddressInfo).port,
    stats: () => ({ sessions: sessions.size, limiterBuckets: viewerLimit.size() + agentLimit.size() }),
    async close() {
      clearInterval(sweep);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const ws of wss.clients) ws.close(1001, 'relay shutting down');
      for (const s of sessions.values()) s.end('shutdown');
      sessions.clear();
      const forced = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
        server.closeAllConnections();
      }, 4000);
      await new Promise<void>((r) => server.close(() => r()));
      clearTimeout(forced);
    },
  };
}
