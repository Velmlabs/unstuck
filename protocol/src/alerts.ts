// Sealing of takeover links to a paired phone (notifications). Web Crypto only.
// Ephemeral ECDH P-256 -> HKDF-SHA-256 -> AES-256-GCM. Blob = base64url(65-byte ephemeral public key | 12-byte IV | ciphertext + tag).
import { b64urlDecode, b64urlEncode } from './e2e';

export interface AlertPayload {
  t: string;
  k: string;
  reason: string;
  site: string;
  expiresAt: number;
}

const PUB_BYTES = 65;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const enc = new TextEncoder();
const dec = new TextDecoder();
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** ECDH P-256 key pair for a paired phone; the private key is non-extractable. */
export function newDeviceKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(CURVE, false, ['deriveBits']) as Promise<CryptoKeyPair>;
}

/** The raw 65-byte uncompressed public key, base64url. */
export async function exportDevicePublicKey(k: CryptoKey): Promise<string> {
  return b64urlEncode(new Uint8Array((await crypto.subtle.exportKey('raw', k)) as ArrayBuffer));
}

async function deriveAesKey(priv: CryptoKey, pub: CryptoKey, deviceId: string, sessionId: string, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  // The Workers typings call this field `$public`; the runtime (and the DOM typings) call it `public`.
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub } as never, priv, 256);
  const hkdf = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(sessionId), info: enc.encode(`unstuck/notify/1|${deviceId}`) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

const aad = (sessionId: string, deviceId: string) => enc.encode(`unstuck/notify/1|${sessionId}|${deviceId}`);

/** Seals the payload to the device's public key; bound to the device and session. */
export async function sealAlert(devicePublicKey: string, deviceId: string, sessionId: string, p: AlertPayload): Promise<string> {
  const raw = b64urlDecode(devicePublicKey);
  if (!raw || raw.length !== PUB_BYTES) throw new Error('invalid device public key');
  const devicePub = await crypto.subtle.importKey('raw', new Uint8Array(raw), CURVE, false, []);
  const eph = (await crypto.subtle.generateKey(CURVE, false, ['deriveBits'])) as CryptoKeyPair;
  // The ephemeral private key is only used here; derive with the device's public key as the peer.
  const key = await deriveAesKey(eph.privateKey, devicePub, deviceId, sessionId, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(sessionId, deviceId) }, key, enc.encode(JSON.stringify(p))),
  );
  const ephPub = new Uint8Array((await crypto.subtle.exportKey('raw', eph.publicKey)) as ArrayBuffer);
  const out = new Uint8Array(PUB_BYTES + IV_BYTES + ct.length);
  out.set(ephPub);
  out.set(iv, PUB_BYTES);
  out.set(ct, PUB_BYTES + IV_BYTES);
  return b64urlEncode(out);
}

/** The payload, or null when the blob wasn't sealed to this key, device and session (or is malformed). */
export async function openAlert(devicePrivateKey: CryptoKey, deviceId: string, sessionId: string, blob: string): Promise<AlertPayload | null> {
  const raw = b64urlDecode(blob);
  if (!raw || raw.length < PUB_BYTES + IV_BYTES + TAG_BYTES) return null;
  try {
    const ephPub = await crypto.subtle.importKey('raw', raw.slice(0, PUB_BYTES), CURVE, false, []);
    const key = await deriveAesKey(devicePrivateKey, ephPub, deviceId, sessionId, 'decrypt');
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(PUB_BYTES, PUB_BYTES + IV_BYTES), additionalData: aad(sessionId, deviceId) },
      key,
      raw.slice(PUB_BYTES + IV_BYTES),
    );
    const p = JSON.parse(dec.decode(pt));
    return p && typeof p === 'object' ? (p as AlertPayload) : null;
  } catch {
    return null;
  }
}

/** Reads `#x=<device id>.<blob>`; null for any other fragment. */
export function parseAlertFragment(hash: string): { deviceId: string; blob: string } | null {
  const m = /^#?x=([^.&=]+)\.([^.&=]+)$/.exec(hash);
  return m ? { deviceId: m[1]!, blob: m[2]! } : null;
}
