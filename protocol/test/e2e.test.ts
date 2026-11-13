import { describe, it, expect } from 'vitest';
import { newE2eKey, importE2eKey, seal, open, b64urlEncode, b64urlDecode, isJsonPlaintext } from '../src/e2e';

const enc = (s: string) => new TextEncoder().encode(s);

describe('end-to-end seal/open', async () => {
  const raw = newE2eKey();
  const key = await importE2eKey(raw);

  it('round-trips JSON and frames', async () => {
    for (const p of [enc('{"t":"ping"}'), new Uint8Array([1, 0, 10, 0, 20, 0xff, 0xd8])]) {
      expect(await open(key, 'S1', 'e2v', await seal(key, 'S1', 'e2v', p))).toEqual(p);
    }
  });
  it('adds 28 bytes and uses a random IV', async () => {
    const p = enc('{"t":"ping"}');
    const a = await seal(key, 'S1', 'v2e', p);
    const b = await seal(key, 'S1', 'v2e', p);
    expect(a.length).toBe(p.length + 28);
    expect(a).not.toEqual(b);
  });
  it('refuses wrong key, session, direction, tampering and short input', async () => {
    const s = await seal(key, 'S1', 'e2v', enc('{"t":"x"}'));
    const other = await importE2eKey(newE2eKey());
    expect(await open(other, 'S1', 'e2v', s)).toBeNull();
    expect(await open(key, 'S2', 'e2v', s)).toBeNull();
    expect(await open(key, 'S1', 'v2e', s)).toBeNull();
    const t = s.slice();
    t[t.length - 1]! ^= 1;
    expect(await open(key, 'S1', 'e2v', t)).toBeNull();
    expect(await open(key, 'S1', 'e2v', new Uint8Array(27))).toBeNull();
  });
  it('base64url round-trips a key and rejects junk', () => {
    expect(raw.length).toBe(32);
    const s = b64urlEncode(raw);
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b64urlDecode(s)).toEqual(raw);
    expect(b64urlDecode('%%')).toBeNull();
  });
  it('classifies JSON plaintext by its first byte', () => {
    expect(isJsonPlaintext(enc('{}'))).toBe(true);
    expect(isJsonPlaintext(new Uint8Array([1]))).toBe(false);
    expect(isJsonPlaintext(new Uint8Array())).toBe(false);
  });
});

describe('per-connection, sequenced messages (Final #8: replay protection)', async () => {
  const { sealMsg, openMsg, newConnNonce } = await import('../src/e2e');
  const key = await importE2eKey(newE2eKey());
  const p = new TextEncoder().encode('{"t":"done"}');

  it('round-trips with the connection nonce and sequence number', async () => {
    const n = newConnNonce();
    expect(n).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const sealed = await sealMsg(key, 'S', 'v2e', n, 7, p);
    expect(sealed.length).toBe(p.length + 32);
    expect(await openMsg(key, 'S', 'v2e', n, sealed)).toEqual({ seq: 7, plain: p });
  });

  it('a message from another connection, or with its sequence number altered, does not open', async () => {
    const sealed = await sealMsg(key, 'S', 'v2e', 'CONN_A', 1, p);
    expect(await openMsg(key, 'S', 'v2e', 'CONN_B', sealed)).toBeNull();
    const bumped = sealed.slice();
    bumped[3]! ^= 1; // seq 1 → 0: the AAD no longer matches
    expect(await openMsg(key, 'S', 'v2e', 'CONN_A', bumped)).toBeNull();
    expect(await openMsg(key, 'S', 'v2e', 'CONN_A', new Uint8Array(31))).toBeNull();
  });
});
