import { openAlert, parseAlertFragment } from '@velmlabs/unstuck-protocol';
import type { DeviceRecord, DeviceStore } from './device-store';
import { CLOUD, cleanApiOrigin } from './pair/env';
import { sessionIdFromPath } from './url';

/** `no_device`: this browser has no paired phone. `not_for_this_device`: it has one, but the link wasn't sealed to it. */
export type AlertLinkError = 'no_device' | 'not_for_this_device';
/** The plain fragment and what was sealed with it, plus this phone's token and the API it was paired with. */
export type OpenedAlert = { hash: string; reason: string; site: string; deviceToken: string; apiBase?: string; mode?: StartMode; question?: string };
/** The sessions whose start page says what they are (a takeover's says "Start takeover"). */
export type StartMode = 'question' | 'approval';
/** The `m` hint a question or approval link carries in its fragment (`&m=q`, `&m=a`). */
export const MODE_HINT: Record<StartMode, string> = { question: 'q', approval: 'a' };

/**
 * Unseals a notified link's `#x=<device id>.<blob>` with this browser's paired-phone key and returns the plain
 * `#t=…&k=…` fragment (in memory only) plus the reason and site that were sealed with it.
 */
export async function openAlertLink(hash: string, pathname: string, store: DeviceStore): Promise<OpenedAlert | { error: AlertLinkError }> {
  let rec;
  try {
    rec = await store.get();
  } catch {
    return { error: 'no_device' };
  }
  if (!rec) return { error: 'no_device' };
  const frag = parseAlertFragment(hash);
  const sessionId = sessionIdFromPath(pathname);
  if (!frag || !sessionId) return { error: 'not_for_this_device' };
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
  const mode = p.mode === 'question' || p.mode === 'approval' ? p.mode : undefined;
  const question = mode === 'question' && typeof p.question === 'string' ? p.question : undefined;
  return {
    // The hint goes in the fragment too, so a reload in this tab (the sealed #x is gone by then) keeps the start page.
    hash: `#t=${encodeURIComponent(p.t)}&k=${encodeURIComponent(p.k)}${mode ? `&m=${MODE_HINT[mode]}` : ''}`,
    reason: p.reason,
    site: p.site,
    ...(mode ? { mode } : {}),
    ...(question !== undefined ? { question } : {}),
    deviceToken: rec.deviceToken,
    ...(rec.apiBase ? { apiBase: rec.apiBase } : {}),
  };
}

const OPEN_TIMEOUT_MS = 5_000;

/** openAlertLink that always settles: any failure, or a store that hangs (IndexedDB blocked) past 5 s, is `no_device`. */
export async function openAlertLinkSafely(hash: string, pathname: string, store: DeviceStore): Promise<OpenedAlert | { error: AlertLinkError }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ error: AlertLinkError }>((resolve) => (timer = setTimeout(() => resolve({ error: 'no_device' }), OPEN_TIMEOUT_MS)));
  try {
    return await Promise.race([Promise.resolve().then(() => openAlertLink(hash, pathname, store)), timeout]);
  } catch {
    return { error: 'no_device' };
  } finally {
    clearTimeout(timer);
  }
}

/** Where to ask who sent an alert: Unstuck Cloud on view.unstuck.sh; elsewhere the API this phone was paired with. */
export function apiBaseForAlerts(hostname: string, rec: Pick<DeviceRecord, 'apiBase'>): string {
  if (hostname === 'view.unstuck.sh') return CLOUD;
  return cleanApiOrigin(rec.apiBase) ?? CLOUD;
}

/** `{keyName}`: Cloud delivered this alert to this phone. `not_sent`: it did not. null: couldn't tell. */
export type Sender = { keyName: string } | 'not_sent' | null;

/** Asks Cloud (with this phone's token) whether it sent this session's alert to this phone, and from which key. */
export async function checkSender(o: { apiBase: string; deviceToken: string; sessionId: string; fetchFn?: typeof fetch }): Promise<Sender> {
  const doFetch = o.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    const res = await doFetch(`${o.apiBase}/api/v1/devices/self/alerts/${encodeURIComponent(o.sessionId)}`, { headers: { Authorization: `Bearer ${o.deviceToken}` } });
    if (res.status === 404) return 'not_sent';
    if (res.status !== 200) return null;
    const body = (await res.json()) as { keyName?: unknown };
    return typeof body?.keyName === 'string' ? { keyName: body.keyName } : null;
  } catch {
    return null;
  }
}

const MAX_LABEL = 64;
/** Shown as plain text: no control, zero-width or bidi characters (no spoofed reordering), at most 64 code points. */
export function cleanLabel(s: string, max = MAX_LABEL): string {
  // eslint-disable-next-line no-control-regex
  return [...s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim()].slice(0, max).join('').trim();
}
