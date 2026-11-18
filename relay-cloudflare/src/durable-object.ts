import { DurableObject } from 'cloudflare:workers';
import { RELAY_CLOSE, RELAY_LIMITS, RELAY_SUBPROTOCOL } from '@velmlabs/unstuck-protocol';
import { newRecord, RelaySession, type OnEvent, type RelaySocket, type SessionRecord, type ViewerMeta } from '@velmlabs/unstuck-relay-core';

/** Per-socket state that survives hibernation. `ip`/`confirmed` are absent on viewers attached before they existed. */
type Attachment = { role: 'agent'; active: boolean } | { role: 'viewer'; c: number; ip?: string | null; confirmed?: boolean };

export const H_SESSION = 'x-unstuck-session';
export const H_ACCOUNT = 'x-unstuck-account';
export const H_KEY_HASH = 'x-unstuck-key-hash';
export const H_IP = 'x-unstuck-ip';
const OPEN = 1; // WebSocket.OPEN

export interface DoOptions<E> {
  onEvent?: (e: Parameters<OnEvent>[0], env: E) => void | Promise<void>;
  now: () => number;
}

/** Agents offered `unstuck-relay.1` and get it back; viewers offered none, and a client must reject one it didn't offer. */
export const upgradeResponse = (client: WebSocket, role: 'agent' | 'viewer' = 'agent') =>
  new Response(null, { status: 101, webSocket: client, headers: role === 'agent' ? { 'Sec-WebSocket-Protocol': RELAY_SUBPROTOCOL } : {} });

/**
 * One Durable Object per takeover (relay spec §4, approach 1). Sockets use the hibernation API; the session
 * record lives in storage and is deleted, with the alarm, when the takeover ends (spec §5.9).
 */
export function makeRelaySessionDO<E>(opts: DoOptions<E>) {
  return class RelaySessionDO extends DurableObject<E> {
    private session: RelaySession | null = null;
    private readonly wrappers = new WeakMap<WebSocket, RelaySocket>();
    private alarmAt: number | null = null;
    /** What was last written; byte counters alone don't justify a write (one per frame would be billed). */
    private savedKey: string | null = null;

    private readonly onEvent: OnEvent = (e) => {
      const p = opts.onEvent?.(e, this.env);
      if (p) this.ctx.waitUntil(Promise.resolve(p).catch(() => {}));
    };

    private wrap(ws: WebSocket): RelaySocket {
      let s = this.wrappers.get(ws);
      if (!s) {
        s = {
          send: (d) => {
            try {
              ws.send(d);
            } catch {
              // already closed
            }
          },
          close: (code, reason) => {
            try {
              ws.close(code, reason);
            } catch {
              // already closed
            }
          },
          bufferedAmount: 0, // hibernatable sockets don't expose it
        };
        this.wrappers.set(ws, s);
      }
      return s;
    }

    private newSession(rec: SessionRecord): RelaySession {
      return new RelaySession(rec, this.onEvent, opts.now, { onViewerConfirmed: (c) => this.markConfirmed(c) });
    }

    /** Persist that viewer c is confirmed, so a rebuilt session never treats the human as evictable. */
    private markConfirmed(c: number): void {
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a?.role === 'viewer' && a.c === c) ws.serializeAttachment({ ...a, confirmed: true } satisfies Attachment);
      }
    }

    /** The live session, rebuilt from storage and the hibernated sockets' attachments if needed. */
    private async load(): Promise<RelaySession | null> {
      if (this.session) return this.session;
      const rec = await this.ctx.storage.get<SessionRecord>('rec');
      if (!rec) return null;
      const s = this.newSession(rec);
      let agent: RelaySocket | null = null;
      const viewers = new Map<number, RelaySocket>();
      const meta = new Map<number, ViewerMeta>();
      const candidates: RelaySocket[] = [];
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a?.role === 'viewer') {
          viewers.set(a.c, this.wrap(ws));
          if (a.confirmed !== undefined) meta.set(a.c, { ip: a.ip ?? null, confirmed: a.confirmed });
        } else if (a?.role !== 'agent') continue;
        // A replaced agent socket may still be closing: never rebind one that isn't open.
        else if (a.active && ws.readyState === OPEN) agent = this.wrap(ws);
        else if (!a.active) candidates.push(this.wrap(ws));
      }
      s.rebind(agent, viewers, meta);
      for (const c of candidates) s.attachAgent(c);
      this.session = s;
      // Backstop (spec §5.9): a record past expiresAt + grace means the alarm never ran; clean up now.
      if (opts.now() >= rec.expiresAt + RELAY_LIMITS.graceMs) {
        s.end('expired');
        await this.settle(s);
        return null;
      }
      return s;
    }

    /**
     * After every change: persist when state that matters changed (registration, billing, agent up/down, viewers,
     * expiry) and re-arm the alarm, or wipe everything once the takeover is over. `flush` also saves byte counters.
     */
    private async settle(s: RelaySession, flush = false): Promise<void> {
      if (s.ended) {
        this.session = null;
        this.alarmAt = null;
        this.savedKey = null;
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.deleteAlarm();
        return;
      }
      const r = s.record;
      const key = JSON.stringify([r.secretHash, r.billed, r.agentDownSince, r.nextC, r.expiresAt, r.keyHash, r.account, r.mode]);
      if (flush || key !== this.savedKey) {
        this.savedKey = key;
        await this.ctx.storage.put('rec', r);
      }
      const at = s.deadline();
      if (at !== this.alarmAt) {
        this.alarmAt = at;
        await this.ctx.storage.setAlarm(at);
      }
    }

    private live(s: RelaySession | null): s is RelaySession {
      return !!s && !s.ended && s.record.secretHash !== null;
    }

    private async quickAnswer(req: Request, s: RelaySession | null): Promise<Response> {
      if (req.method !== 'POST') return new Response(null, { status: 405 });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      const b = body as { choice?: unknown } | null;
      const choice = b?.choice;
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).length !== 1 || typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice > 5) {
        return new Response(null, { status: 400 });
      }
      return new Response(null, { status: this.live(s) && s.quickAnswer(choice) ? 204 : 404 });
    }

    override async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      const id = req.headers.get(H_SESSION) ?? '';
      let s = await this.load();
      if (path === '/status') return new Response(null, { status: this.live(s) ? 204 : 404 });
      // Internal, like /status: only the Worker's own stub calls it (Unstuck Cloud's Telegram callback), never public routing.
      if (path === '/quick_answer') return this.quickAnswer(req, s);

      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      if (path === '/viewer') {
        if (!this.live(s)) return new Response('no such takeover', { status: 404 });
        this.ctx.acceptWebSocket(server);
        const ip = req.headers.get(H_IP) || null;
        const c = s.attachViewer(this.wrap(server), ip);
        if (c === null) server.close(RELAY_CLOSE.tryAgainLater, 'try again later');
        else server.serializeAttachment({ role: 'viewer', c, ip, confirmed: false } satisfies Attachment);
        await this.settle(s);
        return upgradeResponse(client, 'viewer');
      }

      // path === '/agent': the Worker already authorized and rate-limited this agent.
      const keyHash = req.headers.get(H_KEY_HASH) ?? '';
      if (s && s.record.keyHash !== keyHash) {
        server.accept();
        server.close(RELAY_CLOSE.replaced, 'session belongs to another key');
        return upgradeResponse(client);
      }
      if (!s) this.session = s = this.newSession(newRecord(id, req.headers.get(H_ACCOUNT) ?? '', keyHash, opts.now()));
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: 'agent', active: false } satisfies Attachment);
      s.attachAgent(this.wrap(server));
      await this.settle(s);
      return upgradeResponse(client);
    }

    override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
      const s = await this.load();
      if (!s) return ws.close(1011, 'takeover not found');
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) return;
      const data = typeof message === 'string' ? message : new Uint8Array(message);
      if (a.role === 'viewer') s.viewerMessage(a.c, data);
      else {
        const sock = this.wrap(ws);
        s.agentMessage(sock, data);
        await s.flush();
        if (s.isAgent(sock) !== a.active) {
          ws.serializeAttachment({ role: 'agent', active: s.isAgent(sock) } satisfies Attachment);
          // A reconnect replaced the agent: un-tag every other agent socket so a rebuild can't pick it.
          for (const other of this.ctx.getWebSockets()) {
            const o = other.deserializeAttachment() as Attachment | null;
            if (other !== ws && o?.role === 'agent' && o.active) other.serializeAttachment({ role: 'agent', active: false } satisfies Attachment);
          }
        }
      }
      await this.settle(s);
    }

    override async webSocketClose(ws: WebSocket): Promise<void> {
      const s = await this.load();
      if (!s) return;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) return; // a viewer refused before it was attached
      if (a.role === 'viewer') s.viewerClosed(a.c);
      else s.agentClosed(this.wrap(ws));
      await this.settle(s);
    }

    override async webSocketError(ws: WebSocket): Promise<void> {
      await this.webSocketClose(ws);
    }

    override async alarm(): Promise<void> {
      this.alarmAt = null;
      const s = await this.load();
      if (!s) return void (await this.ctx.storage.deleteAll());
      s.tick();
      await this.settle(s, true);
    }
  };
}
