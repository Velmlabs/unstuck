export function parseFragment(hash: string): { token: string } | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('t');
  return token ? { token } : null;
}

/** The session id is the last path segment (/s/<id>, or /takeover/<id> in integrations). */
export function sessionIdFromPath(pathname: string): string | null {
  const m = /\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m && pathname.split('/').filter(Boolean).length >= 2 ? m[1]! : null;
}

export function wsUrlFor(origin: string, sessionId: string): string {
  return `${origin.replace(/^http/, 'ws')}/ws/${sessionId}`;
}
