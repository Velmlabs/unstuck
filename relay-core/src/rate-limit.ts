/** Fixed-window counter per key, in memory. Hosts call prune() from their housekeeping sweep. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number) {
  const buckets = new Map<string, { start: number; count: number }>();
  return {
    take(key: string): boolean {
      const t = now();
      let b = buckets.get(key);
      if (!b || t - b.start >= windowMs) buckets.set(key, (b = { start: t, count: 0 }));
      if (b.count >= limit) return false;
      b.count++;
      return true;
    },
    prune(): void {
      const t = now();
      for (const [k, b] of buckets) if (t - b.start >= windowMs) buckets.delete(k);
    },
    size: () => buckets.size,
  };
}
