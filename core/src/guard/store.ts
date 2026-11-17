import type { StoredCookie } from '@velmlabs/unstuck-protocol';
import { siteOf } from '../session/page-lock';

/** One remembered site: the cookies a person's rescue (or a login) earned, and the User-Agent that earned them. */
export interface SiteRecord {
  site: string;
  userAgent: string;
  solvedAt: number;
  cookies: StoredCookie[];
}

/** Where remembered sites and the rate limiter's history live. Every `site` is normalized to its registrable domain. */
export interface SessionStore {
  load(site: string): Promise<SiteRecord | null>;
  save(site: string, cookies: StoredCookie[], userAgent: string): Promise<void>;
  forget(site: string): Promise<void>;
  forgetAll(): Promise<void>;
  /** Atomically replaces the list of rescue start times and returns the new list. */
  updateRescues(fn: (times: number[]) => number[]): Promise<number[]>;
}

/** The file system a file store needs (Node in sdk-ts and the engine; anything else on other runtimes). */
export interface StoreFs {
  read(path: string): Promise<string | null>;
  writeAtomic(path: string, data: string): Promise<void>;
  withLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
}

export const SITES_FILE_VERSION = 1;
export const RATE_WINDOW_MS = 3_600_000;

export interface SitesFile {
  version: 1;
  sites: Record<string, { userAgent: string; solvedAt: number; cookies: StoredCookie[] }>;
  rescues: number[];
}

const empty = (): SitesFile => ({ version: 1, sites: {}, rescues: [] });
const live = (c: StoredCookie, now: number) => !(c.expires > 0 && c.expires * 1000 <= now);

/** Parses `sites.json`, dropping what has expired. Anything unreadable becomes the empty file (with one warning). */
export function parseSitesFile(text: string | null, now: number, warn?: (l: string) => void, path = 'sites.json'): SitesFile {
  if (text === null) return empty();
  let f: SitesFile;
  try {
    f = JSON.parse(text) as SitesFile;
    if (f?.version !== SITES_FILE_VERSION || typeof f.sites !== 'object' || f.sites === null || !Array.isArray(f.rescues)) throw new Error('bad');
  } catch {
    warn?.(`[unstuck] ${path} is not a valid sites file; starting with no remembered sites`);
    return empty();
  }
  const sites: SitesFile['sites'] = {};
  for (const [site, rec] of Object.entries(f.sites)) {
    const cookies = (rec?.cookies ?? []).filter((c) => live(c, now));
    if (cookies.length > 0) sites[site] = { userAgent: rec.userAgent, solvedAt: rec.solvedAt, cookies };
  }
  return { version: 1, sites, rescues: f.rescues.filter((t) => typeof t === 'number' && t > now - RATE_WINDOW_MS) };
}

const key = (c: StoredCookie) => `${c.name}\u0000${c.domain}\u0000${c.path}`;

function apply(f: SitesFile, op: Op, now: number): unknown {
  switch (op.kind) {
    case 'load': {
      const rec = f.sites[op.site];
      return rec ? { site: op.site, ...rec } : null;
    }
    case 'save': {
      const merged = new Map((f.sites[op.site]?.cookies ?? []).map((c) => [key(c), c]));
      for (const c of op.cookies) merged.set(key(c), c);
      const cookies = [...merged.values()].filter((c) => live(c, now));
      if (cookies.length > 0) f.sites[op.site] = { userAgent: op.userAgent, solvedAt: now, cookies };
      else delete f.sites[op.site];
      return undefined;
    }
    case 'forget':
      delete f.sites[op.site];
      return undefined;
    case 'forgetAll':
      f.sites = {};
      return undefined;
    case 'rescues':
      f.rescues = op.fn([...f.rescues]);
      return [...f.rescues];
  }
}

type Op =
  | { kind: 'load'; site: string }
  | { kind: 'save'; site: string; cookies: StoredCookie[]; userAgent: string }
  | { kind: 'forget'; site: string }
  | { kind: 'forgetAll' }
  | { kind: 'rescues'; fn: (times: number[]) => number[] };

/** Builds a store from "run this operation on the file": every operation reads, changes and writes under one lock. */
function storeOn(run: (op: Op) => Promise<unknown>): SessionStore {
  return {
    load: (site) => run({ kind: 'load', site: siteOf(site) }) as Promise<SiteRecord | null>,
    save: (site, cookies, userAgent) => run({ kind: 'save', site: siteOf(site), cookies, userAgent }).then(() => {}),
    forget: (site) => run({ kind: 'forget', site: siteOf(site) }).then(() => {}),
    forgetAll: () => run({ kind: 'forgetAll' }).then(() => {}),
    updateRescues: (fn) => run({ kind: 'rescues', fn }) as Promise<number[]>,
  };
}

/** A store that lives as long as the process (e.g. in a Worker without storage of its own). */
export function createMemorySessionStore(o: { now?: () => number } = {}): SessionStore {
  const now = o.now ?? Date.now;
  let text: string | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  return storeOn((op) => {
    const next = chain.then(() => {
      const f = parseSitesFile(text, now());
      const out = apply(f, op, now());
      text = JSON.stringify(f);
      return out;
    });
    chain = next.catch(() => {});
    return next;
  });
}

/** A store in one `sites.json`, safe across processes through the StoreFs lock. */
export function createFileSessionStore(fs: StoreFs, file: string, o: { now?: () => number; warn?: (l: string) => void } = {}): SessionStore {
  const now = o.now ?? Date.now;
  return storeOn((op) =>
    fs.withLock(file, async () => {
      const f = parseSitesFile(await fs.read(file), now(), o.warn, file);
      const out = apply(f, op, now());
      if (op.kind !== 'load') await fs.writeAtomic(file, `${JSON.stringify(f, null, 2)}\n`);
      return out;
    }),
  );
}

export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** `<root>/profiles/<profile>/sites.json`; refuses names that could leave the profiles folder. */
export function profileFile(root: string, profile: string): string {
  if (!PROFILE_NAME.test(profile)) throw new TypeError('profile names are letters, digits, "-" and "_" (at most 64), e.g. "default"');
  return `${root}/profiles/${profile}/sites.json`;
}
