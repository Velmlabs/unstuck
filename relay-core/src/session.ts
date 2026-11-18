import { decodeEnvelope, encodeEnvelope, parseAgentToRelay, RELAY_CLOSE, RELAY_LIMITS, type SessionMode } from '@velmlabs/unstuck-protocol';
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
  /** What the takeover is for, from the first hello (a reconnect never changes it). Records stored before modes existed lack it: control. */
  mode: SessionMode;
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
    mode: 'control',
  };
}

/** What a host can persist per viewer (Cloudflare: in the socket's hibernation attachment). */
export interface ViewerMeta {
  ip: string | null;
  confirmed: boolean;
}

export interface RelaySessionOptions {
  /** A viewer just became confirmed (it can no longer be evicted): hosts that hibernate persist this. */
  onViewerConfirmed?: (c: number) => void;
}

interface ViewerSlot {
  socket: RelaySocket;
  ip: string | null;
  /** Agent → viewer payloads delivered to this connection; 2 or more means confirmed. */
  got: number;
  winStart: number;
  winBytes: number;
}

/** Best effort: a host socket may throw on close (invalid code, already closed); the slot must still be freed. */
function safeClose(s: RelaySocket, code: number, reason?: string): void {
  try {
    s.close(code, reason);
  } catch {
    // nothing more to do: the caller forgets the socket either way
  }
}

/**
 * Pairs one agent socket with up to 4 viewer sockets for one takeover and forwards opaque, end-to-end
 * encrypted payloads (relay spec §5.3–§5.5). It owns no timers: hosts call tick() at deadline().
 */
export class RelaySession {
  private rec: SessionRecord;
  private agent: RelaySocket | null = null;
  private readonly candidates = new Set<RelaySocket>();
  private readonly viewers = new Map<number, ViewerSlot>();
  private readonly lastSeen = new Map<RelaySocket, number>();
  private lastPing: number;
  private chain: Promise<void> = Promise.resolve();
  private done = false;

  constructor(
    rec: SessionRecord,
    private readonly onEvent: OnEvent,
    private readonly now: () => number,
    private readonly opts: RelaySessionOptions = {},
  ) {
    this.rec = { ...rec, mode: rec.mode ?? 'control' };
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
      this.forgetViewer(c, false);
      safeClose(v.socket, RELAY_CLOSE.agentReconnecting, 'agent reconnecting');
    }
  }

  /**
   * Returns the connection number, or null when no agent is live or every slot holds a confirmed viewer.
   *
   * Slot squatting (anyone who knows a session id can open /ws/<id>): a viewer is **confirmed** once the agent
   * has sent it at least two payloads. The engine's first payload on every connection is its sealed challenge,
   * and it sends nothing more until a hello sealed with the link's key, so only a viewer holding the link gets
   * confirmed. Confirmed viewers are never evicted. When the slots are full, a new viewer evicts the oldest
   * unconfirmed one (close 1013), and one client IP (when the host passes it) holds at most
   * RELAY_LIMITS.unconfirmedViewersPerIp unconfirmed viewers: its next one evicts its own oldest.
   */
  attachViewer(s: RelaySocket, ip?: string | null): number | null {
    if (this.done || !this.agent) return null;
    const unconfirmed = () => [...this.viewers].filter(([, v]) => v.got < 2).map(([c, v]) => ({ c, ip: v.ip }));
    if (ip) {
      const mine = unconfirmed().filter((v) => v.ip === ip);
      if (mine.length >= RELAY_LIMITS.unconfirmedViewersPerIp) this.dropViewer(mine[0]!.c, RELAY_CLOSE.tryAgainLater, 'replaced by a newer viewer');
    }
    if (this.viewers.size >= RELAY_LIMITS.viewersPerSession) {
      const victim = unconfirmed()[0];
      if (!victim) return null;
      this.dropViewer(victim.c, RELAY_CLOSE.tryAgainLater, 'replaced by a newer viewer');
    }
    const c = this.rec.nextC++;
    this.viewers.set(c, { socket: s, ip: ip || null, got: 0, winStart: this.now(), winBytes: 0 });
    this.lastSeen.set(s, this.now());
    this.rec.viewersSeen++;
    this.agent.send(JSON.stringify({ t: 'open', c }));
    this.emit({ name: 'viewer_connected' });
    return c;
  }

  viewerMessage(c: number, d: string | Uint8Array): void {
    const v = this.viewers.get(c);
    if (this.done || !v || !this.agent) return;
    const t = this.now();
    this.lastSeen.set(v.socket, t);
    if (typeof d === 'string') return this.dropViewer(c, RELAY_CLOSE.badMessage, 'binary only');
    if (d.length > RELAY_LIMITS.viewerPayloadMax) return this.dropViewer(c, RELAY_CLOSE.tooBig, 'too big');
    // Backpressure toward the agent: a viewer can't make the relay buffer without bound.
    if (this.agent.bufferedAmount > RELAY_LIMITS.backpressureBytes) return this.dropViewer(c, RELAY_CLOSE.tryAgainLater, 'agent busy');
    if (t - v.winStart >= RELAY_LIMITS.viewerByteWindowMs) (v.winStart = t), (v.winBytes = 0);
    v.winBytes += d.length;
    if (v.winBytes > RELAY_LIMITS.viewerBytesPerWindow) return this.dropViewer(c, RELAY_CLOSE.policy, 'rate limited');
    this.rec.bytesToAgent += d.length;
    this.agent.send(encodeEnvelope(c, d));
  }

  viewerClosed(c: number): void {
    if (this.done || !this.viewers.has(c)) return;
    this.forgetViewer(c, true);
  }

  /**
   * Re-attach live sockets after hibernation (Cloudflare) from their tags. A viewer with no meta counts as
   * confirmed, so a human is never evicted because a host lost track.
   */
  rebind(agent: RelaySocket | null, viewers: Map<number, RelaySocket>, meta: Map<number, ViewerMeta> = new Map()): void {
    const t = this.now();
    this.agent = this.rec.secretHash !== null ? agent : null;
    if (this.agent) this.lastSeen.set(this.agent, t);
    for (const [c, v] of viewers) {
      const m = meta.get(c);
      this.viewers.set(c, { socket: v, ip: m?.ip ?? null, got: m && !m.confirmed ? 0 : 2, winStart: t, winBytes: 0 });
      this.lastSeen.set(v, t);
    }
  }

  /** Sends a Telegram-style quick answer to the live agent. False when there is no agent or the session is over. */
  quickAnswer(choice: number): boolean {
    if (this.done || !this.agent || !Number.isInteger(choice) || choice < 0 || choice > 5) return false;
    this.agent.send(JSON.stringify({ t: 'quick_answer', choice }));
    return true;
  }

  deadline(): number {
    const d = [this.rec.expiresAt];
    if (this.rec.secretHash === null) d.push(this.rec.createdAt + RELAY_LIMITS.heartbeatMs);
    if (this.agent) d.push(this.lastPing + RELAY_LIMITS.heartbeatMs);
    if (this.rec.agentDownSince !== null) d.push(this.rec.agentDownSince + RELAY_LIMITS.graceMs);
    for (const t of this.lastSeen.values()) d.push(t + RELAY_LIMITS.idleMs);
    return Math.min(...d);
  }

  tick(): 'alive' | 'ended' {
    if (this.done) return 'ended';
    const t = this.now();
    if (t >= this.rec.expiresAt) return this.end('expired'), 'ended';
    // A session nobody registered within 30 s is dropped (spec §5.9), on every host.
    if (this.rec.secretHash === null && t >= this.rec.createdAt + RELAY_LIMITS.heartbeatMs) return this.end('never_registered'), 'ended';
    if (this.rec.agentDownSince !== null && t >= this.rec.agentDownSince + RELAY_LIMITS.graceMs) return this.end('agent_gone'), 'ended';
    for (const [s, seen] of [...this.lastSeen]) {
      if (t - seen < RELAY_LIMITS.idleMs) continue;
      safeClose(s, 1001, 'idle');
      const c = [...this.viewers].find(([, v]) => v.socket === s)?.[0];
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
    for (const v of this.viewers.values()) safeClose(v.socket, 1000, 'takeover ended');
    if (this.agent) safeClose(this.agent, 1000, 'takeover ended');
    for (const s of this.candidates) safeClose(s, 1000, 'takeover ended');
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
      mode: r.mode,
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
          // Forget first: a close that throws must not leak the slot.
          this.forgetViewer(m.c, false);
          safeClose(v.socket, m.code, 'closed by agent');
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
      this.rec.mode = m.mode ?? 'control';
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
      // The engine dropped its side of these viewers when its old socket went: make them reconnect and resume.
      for (const [c, v] of this.viewers) {
        this.forgetViewer(c, false);
        safeClose(v.socket, RELAY_CLOSE.agentReconnecting, 'agent reconnected');
      }
    }
  }

  private forwardToViewer(b: Uint8Array): void {
    const env = decodeEnvelope(b);
    if (!env) return;
    if (env.payload.length > RELAY_LIMITS.agentPayloadMax) return void this.agent?.close(RELAY_CLOSE.tooBig, 'too big');
    const v = this.viewers.get(env.c);
    if (!v) return;
    const big = env.payload.length >= RELAY_LIMITS.billableBytes;
    if (big && v.socket.bufferedAmount > RELAY_LIMITS.backpressureBytes) return; // slow viewer: drop frames, keep control
    v.socket.send(env.payload);
    const confirmed = ++v.got === 2;
    if (confirmed) this.opts.onViewerConfirmed?.(env.c);
    this.rec.bytesToViewers += env.payload.length;
    // Approvals and questions send little data: they are billed when a person is confirmed, not on bytes.
    if (!this.rec.billed && (this.rec.mode === 'control' ? big : confirmed)) {
      this.rec.billed = true;
      this.emit({ name: 'takeover_opened', mode: this.rec.mode });
    }
  }

  private dropViewer(c: number, code: number, reason: string): void {
    const v = this.viewers.get(c);
    this.forgetViewer(c, true);
    if (v) safeClose(v.socket, code, reason);
  }

  private forgetViewer(c: number, tellAgent: boolean): void {
    const v = this.viewers.get(c);
    if (v) this.lastSeen.delete(v.socket);
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
