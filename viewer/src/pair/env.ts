const CLOUD = 'https://unstuck.sh';

/**
 * Where the pair page talks to. On view.unstuck.sh always Unstuck Cloud (a link can't point it elsewhere); on other
 * origins (staging, local development) `?api=` is honoured when it is https, or http on this machine.
 */
export function apiBaseFor(hostname: string, search: string): string {
  if (hostname === 'view.unstuck.sh') return CLOUD;
  const raw = new URLSearchParams(search).get('api');
  if (!raw) return CLOUD;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return CLOUD;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.username || u.password || !(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return CLOUD;
  return u.origin;
}

const isApple = (ua: string, touch: number) => /iPhone|iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1);

/** "iPhone · Home screen app", "Android · Chrome", "Desktop · Firefox": a starting point the person can edit. */
export function defaultLabel(ua: string, standalone: boolean, maxTouchPoints = 0): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  if (isApple(ua, maxTouchPoints)) return `${/iPad|Macintosh/.test(ua) ? 'iPad' : 'iPhone'} · ${standalone ? 'Home screen app' : 'Safari'}`;
  if (/Android/.test(ua)) return `Android · ${browser === 'Chrome' && /SamsungBrowser|OPR\//.test(ua) ? 'Browser' : browser}`;
  return `Desktop · ${browser}`;
}

/** iPhone and iPad only deliver Web Push to the home-screen app, not to Safari. */
export function pushNeedsHomeScreen(ua: string, standalone: boolean, maxTouchPoints: number): boolean {
  return isApple(ua, maxTouchPoints) && !standalone;
}

/** The one-time pairing code in `#c=<code>`. */
export function codeFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('c') || null;
}

/** A typed pairing code like "abcd-efgh" as the 8 uppercase characters Cloud issues; null when it can't be one. */
export function normalizeCode(typed: string): string | null {
  const c = typed.replace(/[\s-]/g, '').toUpperCase();
  return /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(c) ? c : null;
}
