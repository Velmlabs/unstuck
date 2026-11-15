import { openAlert, parseAlertFragment } from '@velmlabs/unstuck-protocol';
import type { DeviceStore } from './device-store';
import { sessionIdFromPath } from './url';

export type AlertLinkError = 'no_device' | 'not_for_this_device';
export type OpenedAlert = { hash: string; reason: string; site: string };

/**
 * Unseals a notified link's `#x=<device id>.<blob>` with this browser's paired-phone key and returns the plain
 * `#t=…&k=…` fragment (in memory only) plus the reason and site that were sealed with it.
 */
export async function openAlertLink(hash: string, pathname: string, store: DeviceStore): Promise<OpenedAlert | { error: AlertLinkError }> {
  const frag = parseAlertFragment(hash);
  const sessionId = sessionIdFromPath(pathname);
  if (!frag || !sessionId) return { error: 'not_for_this_device' };
  let rec;
  try {
    rec = await store.get();
  } catch {
    return { error: 'no_device' };
  }
  if (!rec) return { error: 'no_device' };
  if (rec.deviceId !== frag.deviceId) return { error: 'not_for_this_device' };
  const p = await openAlert(rec.privateKey, frag.deviceId, sessionId, frag.blob);
  if (
    !p ||
    typeof p.t !== 'string' ||
    typeof p.k !== 'string' ||
    typeof p.reason !== 'string' ||
    typeof p.site !== 'string' ||
    typeof p.expiresAt !== 'number' ||
    !Number.isFinite(p.expiresAt)
  )
    return { error: 'not_for_this_device' };
  return { hash: `#t=${encodeURIComponent(p.t)}&k=${encodeURIComponent(p.k)}`, reason: p.reason, site: p.site };
}
