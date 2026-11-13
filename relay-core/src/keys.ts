import type { Authorize } from './hooks';

const enc = new TextEncoder();

/** Hex SHA-256: how agent keys and session secrets are stored and compared. */
export async function hashKey(key: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(key)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two equal-length hex strings. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Self-hosting authorizer: a fixed list of agent keys (UNSTUCK_AGENT_KEYS), or open mode for local testing. */
export function createKeyAuthorizer(opts: { keys: string[] } | { open: true }): Authorize {
  if ('open' in opts) return async () => ({ ok: true, account: 'default' });
  const hashes = Promise.all(opts.keys.map(hashKey));
  return async (key) => {
    if (key) {
      const h = await hashKey(key);
      let match = false;
      for (const x of await hashes) match = sameHash(h, x) || match; // check every key: no early exit
      if (match) return { ok: true, account: 'default' };
    }
    return { ok: false, status: 401, error: 'unauthorized' };
  };
}
