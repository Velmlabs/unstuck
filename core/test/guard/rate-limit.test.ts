import { describe, it, expect } from 'vitest';
import { createRateLimiter, DEFAULT_MAX_RESCUES_PER_HOUR, RATE_WINDOW_MS } from '../../src/guard/rate-limit';
import { createMemorySessionStore } from '../../src/guard/store';

describe('createRateLimiter', () => {
  it('allows 10 starts per hour by default, then reports when the next one is possible', async () => {
    let now = 1_800_000_000_000;
    const l = createRateLimiter(createMemorySessionStore({ now: () => now }), { now: () => now });
    expect(DEFAULT_MAX_RESCUES_PER_HOUR).toBe(10);
    expect(RATE_WINDOW_MS).toBe(3_600_000);
    expect(l.maxPerHour).toBe(10);
    for (let i = 0; i < 10; i++) expect(await l.tryStart()).toEqual({ ok: true });
    expect(await l.tryStart()).toEqual({ ok: false, retryInS: 3600 });
    now += 3_600_001;
    expect(await l.tryStart()).toEqual({ ok: true });
  });

  it('reports the wait until the oldest start leaves the window', async () => {
    let now = 1_800_000_000_000;
    const l = createRateLimiter(createMemorySessionStore({ now: () => now }), { maxPerHour: 1, now: () => now });
    expect(await l.tryStart()).toEqual({ ok: true });
    now += 600_000;
    expect(await l.tryStart()).toEqual({ ok: false, retryInS: 3000 });
  });

  it('rejects maxPerHour 0 and 1.5', () => {
    const s = createMemorySessionStore();
    expect(() => createRateLimiter(s, { maxPerHour: 0 })).toThrow(TypeError);
    expect(() => createRateLimiter(s, { maxPerHour: 1.5 })).toThrow(TypeError);
  });
});
