// End-to-end encryption between engine and viewer (relay spec §5.4). Web Crypto only.
export type Direction = 'e2v' | 'v2e';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const enc = new TextEncoder();

/** 32 random bytes: one AES-256-GCM key per takeover session. */
export function newE2eKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function importE2eKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const aad = (sessionId: string, dir: Direction) => enc.encode(`unstuck/1|${sessionId}|${dir}`);

/** [12-byte random IV][ciphertext + 16-byte tag]; bound to the session and direction. */
export async function seal(key: CryptoKey, sessionId: string, dir: Direction, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(sessionId, dir) }, key, new Uint8Array(plain)));
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(iv);
  out.set(ct, IV_BYTES);
  return out;
}

/** The plaintext, or null when the message wasn't sealed with this key, session and direction. */
export async function open(key: CryptoKey, sessionId: string, dir: Direction, sealed: Uint8Array): Promise<Uint8Array | null> {
  if (sealed.length < IV_BYTES + TAG_BYTES) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.slice(0, IV_BYTES), additionalData: aad(sessionId, dir) },
      key,
      sealed.slice(IV_BYTES),
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

export function b64urlEncode(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Plaintext JSON messages start with '{'; screen frames start with their type byte (0x01). */
export const isJsonPlaintext = (p: Uint8Array): boolean => p[0] === 0x7b;

/**
 * Replay protection (relay spec §5.4): every message on a viewer connection is bound to that connection's random
 * nonce (sent by the engine in a sealed challenge) and carries a sequence number the receiver requires to increase.
 * Format: [seq: u32 big-endian][12-byte IV][ciphertext + tag]; the AAD includes the nonce and the sequence number.
 */
export const newConnNonce = (): string => b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));

const msgAad = (sessionId: string, dir: Direction, conn: string, seq: number) => enc.encode(`unstuck/1|${sessionId}|${dir}|${conn}|${seq}`);

export async function sealMsg(key: CryptoKey, sessionId: string, dir: Direction, conn: string, seq: number, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: msgAad(sessionId, dir, conn, seq) }, key, new Uint8Array(plain)));
  const out = new Uint8Array(4 + IV_BYTES + ct.length);
  new DataView(out.buffer).setUint32(0, seq);
  out.set(iv, 4);
  out.set(ct, 4 + IV_BYTES);
  return out;
}

/** The sequence number and plaintext, or null when the message isn't from this connection or was tampered with. */
export async function openMsg(
  key: CryptoKey,
  sessionId: string,
  dir: Direction,
  conn: string,
  sealed: Uint8Array,
): Promise<{ seq: number; plain: Uint8Array } | null> {
  if (sealed.length < 4 + IV_BYTES + TAG_BYTES) return null;
  const seq = new DataView(sealed.buffer, sealed.byteOffset, sealed.byteLength).getUint32(0);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.slice(4, 4 + IV_BYTES), additionalData: msgAad(sessionId, dir, conn, seq) },
      key,
      sealed.slice(4 + IV_BYTES),
    );
    return { seq, plain: new Uint8Array(pt) };
  } catch {
    return null;
  }
}
