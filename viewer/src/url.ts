import { b64urlDecode } from '@velmlabs/unstuck-protocol';

export type Fragment = { token: string; key: Uint8Array } | { error: 'incomplete' };

/** Reads `#t=<token>&k=<key>`. Null when there's no fragment at all; incomplete when a chat app cut part of it off. */
export function parseFragment(hash: string): Fragment | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  const p = new URLSearchParams(raw);
  const token = p.get('t');
  const key = b64urlDecode(p.get('k') ?? '');
  if (!token || !key || key.length !== 32) return { error: 'incomplete' };
  return { token, key };
}

/** The session id is the last path segment (/s/<id>, or /takeover/<id> in integrations). */
export function sessionIdFromPath(pathname: string): string | null {
  const m = /\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m && pathname.split('/').filter(Boolean).length >= 2 ? m[1]! : null;
}

export function wsUrlFor(origin: string, sessionId: string): string {
  return `${origin.replace(/^http/, 'ws')}/ws/${sessionId}`;
}

type TabStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const linkKey = (sessionId: string) => `unstuck:link:${sessionId}`;

/**
 * The link's fragment (`#t=…&k=…`) is its secret. Once read, it moves to this tab's sessionStorage and leaves the
 * address bar, so browser history, sync and screenshots don't keep it; a reload in the same tab finds it again.
 */
export function takeFragment(
  loc: { hash: string; pathname: string; search: string },
  storage: TabStorage,
  history: { replaceState(data: unknown, unused: string, url: string): void },
): string {
  const id = sessionIdFromPath(loc.pathname) ?? '';
  const hash = loc.hash; // read once: on window.location, replaceState below clears it
  if (hash.replace(/^#/, '')) {
    try {
      storage.setItem(linkKey(id), hash);
    } catch {
      // no storage: the fragment still leaves the address bar; a reload then needs the link again
    }
    try {
      history.replaceState(null, '', loc.pathname + loc.search);
    } catch {
      // keep going with the fragment in the address bar
    }
    return hash;
  }
  try {
    return storage.getItem(linkKey(id)) ?? '';
  } catch {
    return '';
  }
}

/** Drops the stored fragment once the takeover is over. */
export function forgetFragment(sessionId: string, storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(linkKey(sessionId));
  } catch {
    // nothing stored, or storage unavailable
  }
}
