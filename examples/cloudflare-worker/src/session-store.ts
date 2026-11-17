// Remembered sites for Unstuck Browser in a Durable Object's own storage, so a site a person got past stays solved
// across requests and restarts of the object. Pass it as `unstuck.wrap(page, { remember: true, store })`.
// #region session-store
import { siteOf, type SessionStore, type SiteRecord, type StoredCookie } from '@velmlabs/unstuck';

const RATE_WINDOW_MS = 60 * 60 * 1000;
const live = (c: StoredCookie, now: number) => !(c.expires > 0 && c.expires * 1000 <= now);
const cookieKey = (c: StoredCookie) => `${c.name}\u0000${c.domain}\u0000${c.path}`;

type Stored = Omit<SiteRecord, 'site'>;

/** Sites live under `site:<site>`, the hourly rescue times under `rescues`. */
export function durableObjectSessionStore(storage: DurableObjectStorage, o: { now?: () => number } = {}): SessionStore {
  const now = o.now ?? Date.now;
  return {
    async load(site) {
      const s = siteOf(site);
      const rec = await storage.get<Stored>(`site:${s}`);
      const cookies = (rec?.cookies ?? []).filter((c) => live(c, now()));
      return rec && cookies.length > 0 ? { site: s, userAgent: rec.userAgent, solvedAt: rec.solvedAt, cookies } : null;
    },
    async save(site, cookies, userAgent) {
      const key = `site:${siteOf(site)}`;
      await storage.transaction(async (txn) => {
        const merged = new Map(((await txn.get<Stored>(key))?.cookies ?? []).map((c) => [cookieKey(c), c]));
        for (const c of cookies) merged.set(cookieKey(c), c);
        const kept = [...merged.values()].filter((c) => live(c, now()));
        if (kept.length > 0) await txn.put(key, { userAgent, solvedAt: now(), cookies: kept } satisfies Stored);
        else await txn.delete(key);
      });
    },
    async forget(site) {
      await storage.delete(`site:${siteOf(site)}`);
    },
    async forgetAll() {
      const keys = [...(await storage.list({ prefix: 'site:' })).keys()];
      if (keys.length > 0) await storage.delete(keys);
    },
    updateRescues: (fn) =>
      storage.transaction(async (txn) => {
        const recent = ((await txn.get<number[]>('rescues')) ?? []).filter((t) => t > now() - RATE_WINDOW_MS);
        const next = fn(recent);
        await txn.put('rescues', next);
        return [...next];
      }),
  };
}
// #endregion session-store
