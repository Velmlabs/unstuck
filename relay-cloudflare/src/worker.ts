import { KEY_SUBPROTOCOL_PREFIX, RELAY_CLOSE, SESSION_ID_RE } from '@velmlabs/unstuck-protocol';
import { createKeyAuthorizer, hashKey, type Authorize, type RelayEvent } from '@velmlabs/unstuck-relay-core';
import { H_ACCOUNT, H_KEY_HASH, H_SESSION, makeRelaySessionDO, upgradeResponse } from './durable-object';

export interface RelayEnv {
  RELAY_SESSION: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Comma-separated agent keys (wrangler secret put AGENT_KEYS). */
  AGENT_KEYS?: string;
  /** "1" accepts any agent: local testing only. */
  RELAY_OPEN?: string;
  VIEWER_LIMIT?: RateLimit;
  AGENT_LIMIT?: RateLimit;
}

export interface RelayWorkerOptions<E> {
  /** Replaces the default AGENT_KEYS / RELAY_OPEN check (Unstuck Cloud checks API keys and quota here). */
  authorize?: (key: string | null, ctx: { sessionId: string; ip: string }, env: E) => ReturnType<Authorize>;
  onEvent?: (e: RelayEvent, env: E) => void | Promise<void>;
  now?: () => number;
}

const CSP = "default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'";
const EXPIRED_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unstuck</title></head><body style="font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#0f172a;color:#e2e8f0"><main style="text-align:center;padding:16px"><h1 style="font-size:20px">This link has expired or is invalid</h1><p>The takeover already finished or timed out. You can close this tab.</p></main></body></html>';
const pageHeaders = (csp: string) => ({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': csp,
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});

const defaultAuthorize = (env: RelayEnv): Authorize =>
  env.RELAY_OPEN === '1'
    ? createKeyAuthorizer({ open: true })
    : createKeyAuthorizer({ keys: (env.AGENT_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean) });

/** A refused agent: accept, then close with 4000 + status (clients can't read upgrade statuses). */
function refuse(status: number, error: string): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  server.close(RELAY_CLOSE.refused(status), JSON.stringify({ error }));
  return upgradeResponse(client);
}

/** The Cloudflare relay (relay spec §5). Unstuck Cloud imports this with its own authorize/onEvent. */
export function createRelayWorker<E extends RelayEnv = RelayEnv>(opts: RelayWorkerOptions<E> = {}) {
  const now = opts.now ?? Date.now;
  const RelaySessionDO = makeRelaySessionDO<E>({ onEvent: opts.onEvent, now });

  async function fetch(req: Request, env: E): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === '/healthz') return Response.json({ ok: true });
    if (path.startsWith('/assets/')) return env.ASSETS.fetch(req);

    const page = /^\/s\/([^/]+)$/.exec(path);
    if (page) {
      const id = page[1]!;
      const status = SESSION_ID_RE.test(id) ? (await stubFor(env, id).fetch('https://do/status', { headers: { [H_SESSION]: id } })).status : 404;
      if (status !== 204) return new Response(EXPIRED_HTML, { status: 404, headers: pageHeaders("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'") });
      const index = await env.ASSETS.fetch(new Request(new URL('/', url)));
      return new Response(index.body, { status: 200, headers: pageHeaders(CSP) });
    }

    const sock = /^\/(agent|ws)\/([^/]+)$/.exec(path);
    if (!sock || !SESSION_ID_RE.test(sock[2]!)) return new Response('not found', { status: 404 });
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 });
    const [, kind, id] = sock as unknown as [string, 'agent' | 'ws', string];
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';

    if (kind === 'ws') {
      if (env.VIEWER_LIMIT && !(await env.VIEWER_LIMIT.limit({ key: ip })).success) return new Response('too many requests', { status: 429 });
      return stubFor(env, id).fetch('https://do/viewer', { headers: { upgrade: 'websocket', [H_SESSION]: id } });
    }

    const offered = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim());
    const key = offered.find((p) => p.startsWith(KEY_SUBPROTOCOL_PREFIX))?.slice(KEY_SUBPROTOCOL_PREFIX.length) ?? null;
    const keyHash = await hashKey(key ?? '');
    if (env.AGENT_LIMIT && !(await env.AGENT_LIMIT.limit({ key: keyHash })).success) return refuse(429, 'rate_limited');
    const ctx = { sessionId: id, ip };
    const verdict = await (opts.authorize ? opts.authorize(key, ctx, env) : defaultAuthorize(env)(key, ctx)).catch(
      () => ({ ok: false, status: 403, error: 'authorize_failed' }) as const,
    );
    if (!verdict.ok) return refuse(verdict.status, verdict.error);
    // The Durable Object trusts these headers: only this Worker can reach it, and it builds them fresh here.
    return stubFor(env, id).fetch('https://do/agent', { headers: { upgrade: 'websocket', [H_SESSION]: id, [H_ACCOUNT]: verdict.account, [H_KEY_HASH]: keyHash } });
  }

  return { fetch, RelaySessionDO };
}

const stubFor = (env: RelayEnv, id: string) => env.RELAY_SESSION.get(env.RELAY_SESSION.idFromName(id));
