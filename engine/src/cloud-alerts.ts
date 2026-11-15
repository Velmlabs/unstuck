import { sealAlert, type AlertPayload } from '@velmlabs/unstuck-protocol';
import type { LinkInfo } from '@velmlabs/unstuck-core';

export interface CloudAlerterOptions {
  /** Unstuck Cloud's API origin, e.g. https://unstuck.sh. */
  apiBase: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** One line per problem; never contains the link secret or the API key. */
  log?: (line: string) => void;
  now?: () => number;
}

interface Device {
  id: string;
  publicKey: string;
}

const CACHE_MS = 60_000;

/** `t` and `k` from a link's `#t=…&k=…` fragment, plus the URL without it; null when it has none. */
function splitLink(url: string): { t: string; k: string; viewerUrl: string } | null {
  const hash = url.indexOf('#');
  if (hash < 0) return null;
  const q = new URLSearchParams(url.slice(hash + 1));
  const t = q.get('t');
  const k = q.get('k');
  return t && k ? { t, k, viewerUrl: url.slice(0, hash) } : null;
}

/**
 * Seals each takeover link to the account's paired phones and asks Unstuck Cloud to deliver it (notifications spec §4.2).
 * Cloud only ever sees ciphertext. Never rejects: an alert that can't be sent is one line on the log.
 */
export function createCloudAlerter(o: CloudAlerterOptions): (info: LinkInfo, site: string | undefined) => Promise<void> {
  const base = o.apiBase.replace(/\/+$/, '');
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const log = o.log ?? ((l: string) => void process.stderr.write(l + '\n'));
  const now = o.now ?? Date.now;
  const headers = { Authorization: `Bearer ${o.apiKey}` };
  let cache: { at: number; devices: Device[] } | null = null;

  async function devices(): Promise<Device[]> {
    if (cache && now() - cache.at < CACHE_MS) return cache.devices;
    const res = await doFetch(`${base}/api/v1/agent/devices`, { headers });
    let list: Device[] = [];
    if (res.status === 403) log('[unstuck] alerts are not enabled for this API key (turn them on in your unstuck.sh dashboard)');
    else if (!res.ok) throw new Error(`devices lookup answered ${res.status}`);
    else list = ((await res.json()) as { devices: Device[] }).devices;
    cache = { at: now(), devices: list };
    return list;
  }

  return async (info, site) => {
    try {
      const link = splitLink(info.url);
      if (!link) return;
      const list = await devices();
      if (list.length === 0) return;
      const payload: AlertPayload = { t: link.t, k: link.k, reason: info.reason, site: site ?? '', expiresAt: info.expiresAt };
      const sealed = await Promise.all(list.map(async (d) => ({ device: d.id, blob: await sealAlert(d.publicKey, d.id, info.sessionId, payload) })));
      const res = await doFetch(`${base}/api/v1/agent/notify`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: info.sessionId, viewerUrl: link.viewerUrl, sealed }),
      });
      if (!res.ok) throw new Error(`notify answered ${res.status}`);
    } catch (e) {
      // The message can come from fetch internals; the API key and link secret are never part of what we build here.
      log(`[unstuck] could not send the phone alert: ${(e as Error).message.replaceAll(o.apiKey, '***')}`);
    }
  };
}
