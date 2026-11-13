import { describe, it, expect } from 'vitest';
import { newSessionId, newSecret, importSecret, signToken, verifyToken } from '../src/session/tokens';

describe('session ids', () => {
  it('are 22-char base64url and unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newSessionId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('tokens', () => {
  it('a signed token verifies before expiry and returns its session id', async () => {
    const key = await importSecret(newSecret());
    const token = await signToken(key, 'sess', 2000);
    await expect(verifyToken(key, token, 1999)).resolves.toEqual({ ok: true, sessionId: 'sess', expiresAtMs: 2000 });
  });

  it('is expired at exactly expiresAtMs', async () => {
    const key = await importSecret(newSecret());
    const token = await signToken(key, 'sess', 2000);
    await expect(verifyToken(key, token, 2000)).resolves.toEqual({ ok: false, code: 'expired' });
  });

  it('rejects a tampered MAC', async () => {
    const key = await importSecret(newSecret());
    const token = await signToken(key, 'sess', 2000);
    // Flip a character inside the MAC: the last base64url character carries 2 padding bits, so changing
    // it can decode to the same bytes (that made this test fail about 1 run in 16).
    const i = token.length - 10;
    const swapped = token[i] === 'A' ? 'B' : 'A';
    await expect(verifyToken(key, token.slice(0, i) + swapped + token.slice(i + 1), 1)).resolves.toEqual({ ok: false, code: 'token_invalid' });
  });

  it('rejects a tampered payload', async () => {
    const key = await importSecret(newSecret());
    const other = await signToken(key, 'other', 9999);
    const token = await signToken(key, 'sess', 2000);
    const forged = other.split('.')[0] + '.' + token.split('.')[1];
    await expect(verifyToken(key, forged, 1)).resolves.toEqual({ ok: false, code: 'token_invalid' });
  });

  it('rejects a token signed with another secret', async () => {
    const token = await signToken(await importSecret(newSecret()), 'sess', 2000);
    await expect(verifyToken(await importSecret(newSecret()), token, 1)).resolves.toEqual({ ok: false, code: 'token_invalid' });
  });

  it.each(['', 'abc', 'a.b.c', '!!!.###', 'YWJj.YWJj', 'x.YWJj'])('rejects malformed token %j', async (t) => {
    const key = await importSecret(newSecret());
    await expect(verifyToken(key, t, 1)).resolves.toEqual({ ok: false, code: 'token_invalid' });
  });

  it('rejects a validly signed payload without a numeric expiry', async () => {
    const key = await importSecret(newSecret());
    const token = await signToken(key, 'sess', Number.NaN);
    await expect(verifyToken(key, token, 1)).resolves.toEqual({ ok: false, code: 'token_invalid' });
  });

  it('newSecret returns 32 random bytes', () => {
    const a = newSecret();
    expect(a).toHaveLength(32);
    expect(a).not.toEqual(newSecret());
  });
});
