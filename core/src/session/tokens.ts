// Session ids and signed, expiring viewer tokens. Web Crypto only (runs on Node, Workers, Deno, Bun).
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function newSessionId(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function newSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function importSecret(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signToken(key: CryptoKey, sessionId: string, expiresAtMs: number): Promise<string> {
  const payload = enc.encode(`${sessionId}.${expiresAtMs}`);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
  return `${toB64url(payload)}.${toB64url(mac)}`;
}

export type TokenCheck = { ok: true; sessionId: string; expiresAtMs: number } | { ok: false; code: 'token_invalid' | 'expired' };

export async function verifyToken(key: CryptoKey, token: string, nowMs: number): Promise<TokenCheck> {
  const invalid = { ok: false, code: 'token_invalid' } as const;
  const parts = token.split('.');
  if (parts.length !== 2) return invalid;
  const payload = fromB64url(parts[0]!);
  const mac = fromB64url(parts[1]!);
  if (!payload || !mac) return invalid;
  // crypto.subtle.verify compares in constant time.
  if (!(await crypto.subtle.verify('HMAC', key, mac, payload))) return invalid;
  const text = dec.decode(payload);
  const dot = text.lastIndexOf('.');
  const expiresAtMs = Number(text.slice(dot + 1));
  if (dot <= 0 || !Number.isFinite(expiresAtMs)) return invalid;
  if (nowMs >= expiresAtMs) return { ok: false, code: 'expired' };
  return { ok: true, sessionId: text.slice(0, dot), expiresAtMs };
}
