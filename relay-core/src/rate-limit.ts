/**
 * Fixed-window counter per key, in memory. Hosts call prune() from their housekeeping sweep. At most `maxKeys`
 * buckets are kept: a flood of distinct keys evicts the oldest instead of growing without bound.
 */
export function createRateLimiter(limit: number, windowMs: number, now: () => number, maxKeys = 10_000) {
  const buckets = new Map<string, { start: number; count: number }>();
  const current = (key: string, t: number) => {
    const b = buckets.get(key);
    return b && t - b.start < windowMs ? b : undefined;
  };
  return {
    take(key: string): boolean {
      const t = now();
      let b = current(key, t);
      if (!b) {
        buckets.delete(key); // re-insert so Map order stays oldest window first
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value!);
        buckets.set(key, (b = { start: t, count: 0 }));
      }
      if (b.count >= limit) return false;
      b.count++;
      return true;
    },
    /** Whether take() would succeed, without counting. */
    allowed(key: string): boolean {
      return (current(key, now())?.count ?? 0) < limit;
    },
    prune(): void {
      const t = now();
      for (const [k, b] of buckets) if (t - b.start >= windowMs) buckets.delete(k);
    },
    size: () => buckets.size,
  };
}
