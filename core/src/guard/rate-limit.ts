import { RATE_WINDOW_MS, type SessionStore } from './store';

export { RATE_WINDOW_MS } from './store';
export const DEFAULT_MAX_RESCUES_PER_HOUR = 10;

export interface RateLimiter {
  /** The most person-checks allowed in any hour. */
  readonly maxPerHour: number;
  /** Reserves one person-check, or says how long until the next one is possible. */
  tryStart(): Promise<{ ok: true } | { ok: false; retryInS: number }>;
}

/** At most `maxPerHour` person-checks in any hour, counted per profile in its store (so across processes). */
export function createRateLimiter(store: SessionStore, o: { maxPerHour?: number; now?: () => number } = {}): RateLimiter {
  const max = o.maxPerHour ?? DEFAULT_MAX_RESCUES_PER_HOUR;
  if (!Number.isInteger(max) || max < 1) throw new TypeError('maxRescuesPerHour must be a whole number of at least 1');
  const now = o.now ?? Date.now;
  return {
    maxPerHour: max,
    async tryStart() {
      let retryInS = 0;
      let ok = false;
      await store.updateRescues((times) => {
        const t = now();
        const recent = times.filter((x) => x > t - RATE_WINDOW_MS).sort((a, b) => a - b);
        if (recent.length < max) {
          ok = true;
          return [...recent, t];
        }
        retryInS = Math.ceil((recent[recent.length - max]! + RATE_WINDOW_MS - t) / 1000);
        return recent;
      });
      return ok ? { ok: true } : { ok: false, retryInS };
    },
  };
}
