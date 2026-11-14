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
