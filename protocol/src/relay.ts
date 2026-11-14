// Relay wire protocol (relay spec §5.2–§5.5): agent socket control messages and envelopes.
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const RELAY_SUBPROTOCOL = 'unstuck-relay.1';
export const KEY_SUBPROTOCOL_PREFIX = 'key.';
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const RELAY_LIMITS = {
  agentPayloadMax: 2_097_152,
  viewerPayloadMax: 65_536,
  viewersPerSession: 4,
  /** Viewers that haven't been confirmed (see relay-core attachViewer) one client IP may hold in one session. */
  unconfirmedViewersPerIp: 2,
  /** Viewer → agent bytes one viewer connection may send per window. */
  viewerBytesPerWindow: 2_097_152,
  viewerByteWindowMs: 10_000,
  idleMs: 120_000,
  heartbeatMs: 30_000,
  graceMs: 60_000,
  maxExpiryMs: 3_600_000,
  billableBytes: 4096,
  backpressureBytes: 4_194_304,
  viewerUpgradesPerMinPerIp: 30,
  agentUpgradesPerMinPerKey: 20,
  /** Agent upgrades per client IP per minute, counted on refused authorizations only (key brute force). */
  agentAuthFailuresPerMinPerIp: 10,
} as const;

export const RELAY_CLOSE = {
  agentReconnecting: 1012,
  replaced: 4409,
  badMessage: 1003,
  tooBig: 1009,
  policy: 1008,
  tryAgainLater: 1013,
  /** A refused agent: 4000 + the HTTP status (4401, 4402, 4403, 4429). Clients can't read upgrade statuses. */
  refused: (status: number) => 4000 + status,
} as const;

/** `registered` confirms a hello (first registration or a reconnect); only then is the session live. */
export type RelayToAgent = { t: 'open'; c: number } | { t: 'close'; c: number } | { t: 'ping' } | { t: 'registered' };
export type AgentToRelay =
  | { t: 'hello'; expiresAt: number; secret: string }
  | { t: 'close'; c: number; code: number }
  | { t: 'pong' }
  | { t: 'end' }
  | { t: 'event'; name: string };

const C = Type.Integer({ minimum: 1, maximum: 0xffffffff });
const strict = { additionalProperties: false } as const;
/**
 * A close code a server socket can send: 1000–1003, 1007–1014 or 3000–4999. The engine uses 1008 and 1013, so
 * the browser-only rule (1000 or 3000–4999) would be too strict; 1004–1006 and 1015 are reserved and throw.
 */
const CloseCode = Type.Union([
  Type.Integer({ minimum: 1000, maximum: 1003 }),
  Type.Integer({ minimum: 1007, maximum: 1014 }),
  Type.Integer({ minimum: 3000, maximum: 4999 }),
]);
const RelayToAgentSchema = Type.Union([
  Type.Object({ t: Type.Literal('open'), c: C }, strict),
  Type.Object({ t: Type.Literal('close'), c: C }, strict),
  Type.Object({ t: Type.Literal('ping') }, strict),
  Type.Object({ t: Type.Literal('registered') }, strict),
]);
const AgentToRelaySchema = Type.Union([
  Type.Object({ t: Type.Literal('hello'), expiresAt: Type.Number(), secret: Type.String({ minLength: 1, maxLength: 128 }) }, strict),
  Type.Object({ t: Type.Literal('close'), c: C, code: CloseCode }, strict),
  Type.Object({ t: Type.Literal('pong') }, strict),
  Type.Object({ t: Type.Literal('end') }, strict),
  Type.Object({ t: Type.Literal('event'), name: Type.String({ maxLength: 64 }) }, strict),
]);

function parse<T>(schema: Parameters<typeof Value.Check>[0], raw: string): T | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  return Value.Check(schema, v) ? (v as T) : null;
}

export const parseRelayToAgent = (raw: string) => parse<RelayToAgent>(RelayToAgentSchema, raw);
export const parseAgentToRelay = (raw: string) => parse<AgentToRelay>(AgentToRelaySchema, raw);

/** [c: u32 big-endian][payload]: one viewer connection's message on the agent socket. */
export function encodeEnvelope(c: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(c) || c < 0 || c > 0xffffffff) throw new RangeError(`connection number out of range: ${c}`);
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, c);
  out.set(payload, 4);
  return out;
}

export function decodeEnvelope(b: Uint8Array): { c: number; payload: Uint8Array } | null {
  if (b.length < 4) return null;
  return { c: new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0), payload: b.slice(4) };
}
