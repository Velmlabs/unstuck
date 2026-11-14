import { describe, it, expect } from 'vitest';
import { createKeyAuthorizer, hashKey } from '../src/keys';
import { createRateLimiter } from '../src/rate-limit';
import { refusalReason } from '../src/close-reason';

const ctx = { sessionId: 'S', ip: '1.2.3.4' };

describe('createKeyAuthorizer', () => {
  it('accepts listed keys only', async () => {
    const auth = createKeyAuthorizer({ keys: ['k1', 'k2'] });
    expect(await auth('k2', ctx)).toEqual({ ok: true, account: 'default' });
    expect(await auth('nope', ctx)).toEqual({ ok: false, status: 401, error: 'unauthorized' });
    expect(await auth(null, ctx)).toMatchObject({ ok: false, status: 401 });
  });
  it('open mode accepts anything, including no key', async () => {
    const auth = createKeyAuthorizer({ open: true });
    expect(await auth(null, ctx)).toEqual({ ok: true, account: 'default' });
  });
  it('hashKey is hex SHA-256', async () => {
    expect(await hashKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('createRateLimiter', () => {
  it('allows the limit within the window, then refuses, then allows again', () => {
    let now = 0;
    const rl = createRateLimiter(30, 60_000, () => now);
    for (let i = 0; i < 30; i++) expect(rl.take('ip')).toBe(true);
    expect(rl.take('ip')).toBe(false);
    expect(rl.take('other')).toBe(true);
    now = 60_000;
    expect(rl.take('ip')).toBe(true);
  });
  it('prune empties expired buckets', () => {
    let now = 0;
    const rl = createRateLimiter(1, 1000, () => now);
    rl.take('a');
    rl.take('b');
    expect(rl.size()).toBe(2);
    now = 1000;
    rl.prune();
    expect(rl.size()).toBe(0);
  });
});

describe('createRateLimiter: bounded memory (security finding 1)', () => {
  it('holds at most maxKeys buckets, evicting the oldest', () => {
    let now = 0;
    const rl = createRateLimiter(1, 60_000, () => now, 3);
    for (const k of ['a', 'b', 'c']) expect(rl.take(k)).toBe(true);
    now = 1;
    expect(rl.take('d')).toBe(true);
    expect(rl.size()).toBe(3);
    expect(rl.take('a')).toBe(true); // 'a' was evicted, so it starts over
    expect(rl.take('c')).toBe(false); // 'c' is still counted
  });
  it('a bucket whose window restarts becomes the newest', () => {
    let now = 0;
    const rl = createRateLimiter(1, 1000, () => now, 2);
    rl.take('a');
    now = 500;
    rl.take('b');
    now = 1000;
    rl.take('a'); // new window for 'a': now newer than 'b'
    rl.take('c'); // evicts 'b'
    expect(rl.take('a')).toBe(false);
    expect(rl.take('b')).toBe(true);
  });
  it('allowed() reports without counting', () => {
    const rl = createRateLimiter(1, 1000, () => 0);
    expect(rl.allowed('x')).toBe(true);
    expect(rl.allowed('x')).toBe(true);
    rl.take('x');
    expect(rl.allowed('x')).toBe(false);
  });
});

describe('refusalReason (security finding 9)', () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  it('is the JSON error when it fits', () => {
    expect(refusalReason('unauthorized')).toBe('{"error":"unauthorized"}');
  });
  it('shortens the error so the reason stays valid JSON within 123 bytes', () => {
    for (const e of ['x'.repeat(500), 'é'.repeat(200), '😀'.repeat(100), '"\\'.repeat(100)]) {
      const r = refusalReason(e);
      expect(bytes(r)).toBeLessThanOrEqual(123);
      expect(e.startsWith(JSON.parse(r).error)).toBe(true);
    }
  });
});
