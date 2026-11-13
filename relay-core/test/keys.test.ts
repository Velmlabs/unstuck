import { describe, it, expect } from 'vitest';
import { createKeyAuthorizer, hashKey } from '../src/keys';
import { createRateLimiter } from '../src/rate-limit';

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
