import { decodeEnvelope, encodeEnvelope, parseAgentToRelay, RELAY_CLOSE, RELAY_LIMITS } from '@unstuck/protocol';
import type { OnEvent, RelayEvent } from './hooks';
import { hashKey, sameHash } from './keys';

/** A socket as the host sees it: a ws socket on Node, a hibernatable WebSocket on Cloudflare. */
export interface RelaySocket {
  send(d: string | Uint8Array): void;
  close(code: number, reason?: string): void;
  readonly bufferedAmount: number;
}

/** Everything a session must remember across Durable Object hibernation. Never screen data. */
export interface SessionRecord {
  sessionId: string;
  account: string;
  keyHash: string;
  secretHash: string | null;
  expiresAt: number;
  createdAt: number;
  agentDownSince: number | null;
  nextC: number;
  billed: boolean;
  bytesToViewers: number;
  bytesToAgent: number;
  viewersSeen: number;
}

export function newRecord(sessionId: string, account: string, keyHash: string, now: number): SessionRecord {
  return {
    sessionId,
    account,
    keyHash,
    secretHash: null,
    expiresAt: now + RELAY_LIMITS.maxExpiryMs,
    createdAt: now,
    agentDownSince: null,
    nextC: 1,
    billed: false,
    bytesToViewers: 0,
    bytesToAgent: 0,
    viewersSeen: 0,
  };
}

/**
 * Pairs one agent socket with up to 4 viewer sockets for one takeover and forwards opaque, end-to-end
 * encrypted payloads (relay spec §5.3–§5.5). It owns no timers: hosts call tick() at deadline().
 */
export class RelaySession {
  private rec: SessionRecord;
  private agent: RelaySocket | null = null;
  private readonly candidates = new Set<RelaySocket>();
  private readonly viewers = new Map<number, RelaySocket>();
  private readonly lastSeen = new Map<RelaySocket, number>();
  private lastPing: number;
  private chain: Promise<void> = Promise.resolve();
  private done = false;

  constructor(
    rec: SessionRecord,
    private readonly onEvent: OnEvent,
    private readonly now: () => number,
  ) {
    this.rec = { ...rec };
    this.lastPing = now();
  }

  get record(): SessionRecord {
    return { ...this.rec };
  }
  get ended(): boolean {
    return this.done;
  }
  /** Resolves once queued agent messages (hello needs hashing) are handled. */
  flush(): Promise<void> {
    return this.chain;
  }

  /** True for the socket currently registered as this session's agent (hosts persist this across hibernation). */
  isAgent(s: RelaySocket): boolean {
    return s === this.agent;
  }

  attachAgent(s: RelaySocket): void {
    if (this.done) return void s.close(1000, 'session ended');
    this.candidates.add(s);
    this.lastSeen.set(s, this.now());
  }

  agentMessage(s: RelaySocket, d: string | Uint8Array): void {
    if (this.done) return;
    this.lastSeen.set(s, this.now());
    this.chain = this.chain.then(() => this.handleAgent(s, d)).catch(() => {});
  }

  agentClosed(s: RelaySocket): void {
    this.candidates.delete(s);
    this.lastSeen.delete(s);
    if (this.done || s !== this.agent) return;
    this.agent = null;
    this.rec.agentDownSince = this.now();
    for (const [c, v] of this.viewers) {
      v.close(RELAY_CLOSE.agentReconnecting, 'agent reconnecting');
      this.forgetViewer(c, false);
    }
  }

  /** Returns the connection number, or null when no agent is live or 4 viewers are already attached. */
  attachViewer(s: RelaySocket): number | null {
    if (this.done || !this.agent || this.viewers.size >= RELAY_LIMITS.viewersPerSession) return null;
    const c = this.rec.nextC++;
    this.viewers.set(c, s);
    this.lastSeen.set(s, this.now());
    this.rec.viewersSeen++;
    this.agent.send(JSON.stringify({ t: 'open', c }));
    this.emit({ name: 'viewer_connected' });
    return c;
  }

  viewerMessage(c: number, d: string | Uint8Array): void {
    const v = this.viewers.get(c);
    if (this.done || !v || !this.agent) return;
    this.lastSeen.set(v, this.now());
    if (typeof d === 'string') return this.dropViewer(c, RELAY_CLOSE.badMessage, 'binary only');
    if (d.length > RELAY_LIMITS.viewerPayloadMax) return this.dropViewer(c, RELAY_CLOSE.tooBig, 'too big');
    this.rec.bytesToAgent += d.length;
    this.agent.send(encodeEnvelope(c, d));
  }

  viewerClosed(c: number): void {
    if (this.done || !this.viewers.has(c)) return;
    this.forgetViewer(c, true);
  }

  /** Re-attach live sockets after hibernation (Cloudflare) from their tags. */
  rebind(agent: RelaySocket | null, viewers: Map<number, RelaySocket>): void {
    const t = this.now();
    this.agent = this.rec.secretHash !== null ? agent : null;
    if (this.agent) this.lastSeen.set(this.agent, t);
    for (const [c, v] of viewers) {
      this.viewers.set(c, v);
      this.lastSeen.set(v, t);
    }
  }

  deadline(): number {
    const d = [this.rec.expiresAt];
    if (this.agent) d.push(this.lastPing + RELAY_LIMITS.heartbeatMs);
    if (this.rec.agentDownSince !== null) d.push(this.rec.agentDownSince + RELAY_LIMITS.graceMs);
    for (const t of this.lastSeen.values()) d.push(t + RELAY_LIMITS.idleMs);
    return Math.min(...d);
  }

  tick(): 'alive' | 'ended' {
    if (this.done) return 'ended';
    const t = this.now();
    if (t >= this.rec.expiresAt) return this.end('expired'), 'ended';
    if (this.rec.agentDownSince !== null && t >= this.rec.agentDownSince + RELAY_LIMITS.graceMs) return this.end('agent_gone'), 'ended';
    for (const [s, seen] of [...this.lastSeen]) {
      if (t - seen < RELAY_LIMITS.idleMs) continue;
      s.close(1001, 'idle');
      const c = [...this.viewers].find(([, v]) => v === s)?.[0];
      if (c !== undefined) this.forgetViewer(c, true);
      else this.agentClosed(s);
    }
    if (this.agent && t - this.lastPing >= RELAY_LIMITS.heartbeatMs) {
      this.agent.send('{"t":"ping"}');
      this.lastPing = t;
    }
    return 'alive';
  }

  end(_reason: string): void {
    if (this.done) return;
    this.done = true;
    for (const v of this.viewers.values()) v.close(1000, 'takeover ended');
    this.agent?.close(1000, 'takeover ended');
    for (const s of this.candidates) s.close(1000, 'takeover ended');
    this.viewers.clear();
    this.candidates.clear();
    this.lastSeen.clear();
    this.agent = null;
    const r = this.rec;
    this.emit({
      name: 'session_closed',
      durationMs: this.now() - r.createdAt,
      bytesToViewers: r.bytesToViewers,
      bytesToAgent: r.bytesToAgent,
      viewers: r.viewersSeen,
    });
  }

  private async handleAgent(s: RelaySocket, d: string | Uint8Array): Promise<void> {
    if (this.done) return;
    if (this.candidates.has(s)) return this.handleCandidate(s, d);
    if (s !== this.agent) return;
    if (typeof d !== 'string') return this.forwardToViewer(d);
    const m = parseAgentToRelay(d);
    if (!m) return;
    switch (m.t) {
      case 'close': {
        const v = this.viewers.get(m.c);
        if (v) {
          v.close(m.code, 'closed by agent');
          this.forgetViewer(m.c, false);
        }
        return;
      }
      case 'end':
        return this.end('agent_end');
      case 'event':
        return this.emit({ name: 'agent_event', event: m.name });
      default:
        return; // pong (activity already noted) or a repeated hello
    }
  }

  /** A socket that hasn't said hello yet: the first agent registers; later ones must prove the secret. */
  private async handleCandidate(s: RelaySocket, d: string | Uint8Array): Promise<void> {
    const m = typeof d === 'string' ? parseAgentToRelay(d) : null;
    if (!m || m.t !== 'hello') {
      this.candidates.delete(s);
      return s.close(RELAY_CLOSE.badMessage, 'hello first');
    }
    const h = await hashKey(m.secret);
    if (this.done) return;
    this.candidates.delete(s);
    if (this.rec.secretHash === null) {
      this.rec.secretHash = h;
      this.rec.expiresAt = Math.min(m.expiresAt, this.now() + RELAY_LIMITS.maxExpiryMs);
      this.agent = s;
      s.send('{"t":"registered"}');
      return this.emit({ name: 'session_opened' });
    }
    if (!sameHash(h, this.rec.secretHash)) return s.close(RELAY_CLOSE.replaced, 'session belongs to another agent');
    const old = this.agent;
    this.agent = s;
    this.rec.agentDownSince = null;
    s.send('{"t":"registered"}');
    if (old) {
      this.lastSeen.delete(old);
      old.close(RELAY_CLOSE.replaced, 'replaced by reconnect');
    }
  }

  private forwardToViewer(b: Uint8Array): void {
    const env = decodeEnvelope(b);
    if (!env) return;
    if (env.payload.length > RELAY_LIMITS.agentPayloadMax) return void this.agent?.close(RELAY_CLOSE.tooBig, 'too big');
    const v = this.viewers.get(env.c);
    if (!v) return;
    const big = env.payload.length >= RELAY_LIMITS.billableBytes;
    if (big && v.bufferedAmount > RELAY_LIMITS.backpressureBytes) return; // slow viewer: drop frames, keep control
    v.send(env.payload);
    this.rec.bytesToViewers += env.payload.length;
    if (big && !this.rec.billed) {
      this.rec.billed = true;
      this.emit({ name: 'takeover_opened' });
    }
  }

  private dropViewer(c: number, code: number, reason: string): void {
    this.viewers.get(c)?.close(code, reason);
    this.forgetViewer(c, true);
  }

  private forgetViewer(c: number, tellAgent: boolean): void {
    const v = this.viewers.get(c);
    if (v) this.lastSeen.delete(v);
    this.viewers.delete(c);
    if (tellAgent) this.agent?.send(JSON.stringify({ t: 'close', c }));
  }

  private emit(e: { name: RelayEvent['name']; [k: string]: unknown }): void {
    const ev = { sessionId: this.rec.sessionId, account: this.rec.account, at: this.now(), ...e } as RelayEvent;
    try {
      void Promise.resolve(this.onEvent(ev)).catch(() => {}); // a failing hook never breaks forwarding
    } catch {
      // same for a hook that throws synchronously
    }
  }
}
