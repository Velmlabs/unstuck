import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Transport, ViewerConnection } from '@velmlabs/unstuck-core';

export type AssetMap = Record<string, { type: string; body: string /* base64 */ }>;

export interface EmbeddedOptions {
  assets: AssetMap;
  host?: string;
  port?: number;
  /** Base URL humans use to reach this server (e.g. behind a tunnel). Defaults to http://host:port. */
  publicUrl?: string;
  warn?: (msg: string) => void;
  env?: Record<string, string | undefined>;
}

export const EXPIRED_HTML_MARKER = 'expired or is invalid';
const CSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'";
const EXPIRED_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
const EXPIRED_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unstuck</title></head><body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#0f172a;color:#e2e8f0"><main style="text-align:center;padding:16px"><h1 style="font-size:20px">This link has ${EXPIRED_HTML_MARKER}</h1><p>The takeover already finished or timed out. You can close this tab.</p></main></body></html>`;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const MAX_VIEWER_MESSAGE = 64 * 1024;

function wrap(ws: WebSocket): ViewerConnection {
  return {
    send(data) {
      if (typeof data === 'string') ws.send(data);
      else ws.send(data, { binary: true });
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    onMessage(h) {
      ws.on('message', (data: Buffer, isBinary: boolean) => h(isBinary ? new Uint8Array(data) : data.toString('utf8')));
    },
    onClose(h) {
      ws.on('close', () => h());
    },
    close(code, reason) {
      ws.close(code, reason);
    },
  };
}

export async function createEmbeddedTransport(opts: EmbeddedOptions): Promise<Transport & { host: string; port: number }> {
  const env = opts.env ?? process.env;
  const host = opts.host ?? env.UNSTUCK_HOST ?? '127.0.0.1';
  const port = opts.port ?? (env.UNSTUCK_PORT ? Number(env.UNSTUCK_PORT) : 0);
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`[unstuck] ${m}\n`));
  const sessions = new Map<string, ((c: ViewerConnection) => void) | null>();
  const sockets = new Set<WebSocket>();

  const sendHtml = (res: http.ServerResponse, status: number, body: string | Buffer, csp = CSP) => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const session = /^\/s\/([A-Za-z0-9_-]+)$/.exec(path);
    if (session) {
      const index = opts.assets['/index.html'];
      if (sessions.has(session[1]!) && index) return sendHtml(res, 200, Buffer.from(index.body, 'base64'));
      return sendHtml(res, 404, EXPIRED_HTML, EXPIRED_CSP);
    }
    const asset = opts.assets[path];
    if (asset && path !== '/index.html') {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
      return res.end(Buffer.from(asset.body, 'base64'));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_VIEWER_MESSAGE });
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const m = /^\/ws\/([A-Za-z0-9_-]+)$/.exec(new URL(req.url ?? '/', 'http://x').pathname);
    const id = m?.[1];
    if (!id || !sessions.has(id)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      const handler = sessions.get(id);
      if (handler) handler(wrap(ws));
      else ws.close(1013, 'not ready');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = (server.address() as AddressInfo).port;
  if (!LOOPBACK.has(host)) warn(`viewer server on ${host}:${actualPort} is reachable from your network; takeover links still require their token.`);
  const base = (opts.publicUrl ?? env.UNSTUCK_PUBLIC_URL ?? `http://${host}:${actualPort}`).replace(/\/+$/, '');

  return {
    host,
    port: actualPort,
    async publish(sessionId, _opts) {
      if (!sessions.has(sessionId)) sessions.set(sessionId, null);
      return { baseUrl: `${base}/s/${sessionId}` };
    },
    onConnection(sessionId, h) {
      sessions.set(sessionId, h);
    },
    async unpublish(sessionId) {
      sessions.delete(sessionId);
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections(); // a human tab mid-request must not stall shutdown
      });
    },
  };
}
