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

/** The start-page hint of a question or approval link (`&m=q`, `&m=a`); null for any other link. */
export function modeHint(hash: string): 'question' | 'approval' | null {
  const m = new URLSearchParams(hash.replace(/^#/, '')).get('m');
  return m === 'q' ? 'question' : m === 'a' ? 'approval' : null;
}

/** The session id is the last path segment (/s/<id>, or /takeover/<id> in integrations). */
export function sessionIdFromPath(pathname: string): string | null {
  const m = /\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m && pathname.split('/').filter(Boolean).length >= 2 ? m[1]! : null;
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

/**
 * The relay this page talks to: the one named in ?r= when the viewer is served from its own origin (only wss://, or
 * ws:// on this machine, and no path or credentials), otherwise the page's own origin (the relay served the page).
 */
export function relayFor(search: string, origin: string): { ws: string; http: string } {
  const own = { ws: origin.replace(/^http/, 'ws'), http: origin };
  const r = new URLSearchParams(search).get('r');
  if (!r) return own;
  let u: URL;
  try {
    u = new URL(r);
  } catch {
    return own;
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  const ok = (u.protocol === 'wss:' || (u.protocol === 'ws:' && local)) && (u.pathname === '/' || u.pathname === '') && !u.username && !u.password && !u.search && !u.hash;
  if (!ok) return own;
  return { ws: `${u.protocol}//${u.host}`, http: `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}` };
}

/** An alert the Android app already unsealed and whose sender it checked with Cloud natively. */
export interface InAppAlert {
  reason: string;
  site: string;
  mode?: 'question' | 'approval';
  question?: string;
  sender: () => Promise<{ keyName: string }>;
}

/** The app's own marker in its WebView's user agent: only pages the app opened carry it. */
export const IN_APP_UA = 'UnstuckAndroid/';

/**
 * The Android app's fragment: `#t=…&k=…[&m=q|a]&from=<key>&r=<reason>&s=<site>[&q=<question>]`. Honored only inside
 * the app (user agent `UnstuckAndroid/…`): anywhere else a link could claim any sender, so these are ignored there.
 */
export function inAppAlert(hash: string, userAgent: string): InAppAlert | null {
  if (!userAgent.includes(IN_APP_UA)) return null;
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const from = p.get('from');
  const reason = p.get('r');
  const site = p.get('s');
  if (!from || reason === null || site === null) return null;
  const m = p.get('m');
  const mode = m === 'q' ? 'question' : m === 'a' ? 'approval' : undefined;
  const question = p.get('q');
  return { reason, site, ...(mode ? { mode } : {}), ...(question !== null ? { question } : {}), sender: () => Promise.resolve({ keyName: from }) };
}
