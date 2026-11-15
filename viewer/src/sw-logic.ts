import { openAlertLink } from './alert-link';
import type { DeviceStore } from './device-store';

export interface SwDeps {
  /** The service worker's own origin: links to anywhere else are never opened. */
  origin: string;
  openWindow(url: string): Promise<unknown>;
}

export interface ShownNotification {
  title: string;
  options: { body: string; data: { link?: string } };
}

const GENERIC = 'Your agent needs you';

/** A link on this origin; push payloads are untrusted, so a link to another site is treated as no link. */
function ownUrl(v: unknown, origin: string): URL | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin ? u : null;
  } catch {
    return null;
  }
}

/**
 * What a push payload (`{kind:'takeover', link, keyName}` or `{kind:'test'}`) shows. A takeover's reason and site are
 * unsealed on this phone from the link's own `#x=…`; when that fails the notification is still shown, without them.
 */
export async function notificationFor(data: unknown, store: DeviceStore, origin: string): Promise<ShownNotification> {
  const d = data as { kind?: unknown; link?: unknown; keyName?: unknown } | null;
  if (!d || typeof d !== 'object') return { title: GENERIC, options: { body: '', data: {} } };
  if (d.kind === 'test') return { title: 'Test alert from Unstuck', options: { body: '', data: {} } };
  if (d.kind !== 'takeover') return { title: GENERIC, options: { body: '', data: {} } };
  const key = typeof d.keyName === 'string' ? d.keyName : '';
  const body = key ? `Sent by key: ${key}` : '';
  const url = ownUrl(d.link, origin);
  if (!url) return { title: GENERIC, options: { body, data: {} } };
  let title = GENERIC;
  try {
    const opened = await openAlertLink(url.hash, url.pathname, store);
    if (!('error' in opened)) title = `${GENERIC}: ${opened.reason}${opened.site ? ` · ${opened.site}` : ''}`;
  } catch {
    // unreadable here: the generic title still tells the person to look
  }
  return { title, options: { body, data: { link: url.href } } };
}

/** Opens the notification's link; a test alert (no link) does nothing. */
export async function handleClick(data: { link?: unknown } | null | undefined, deps: SwDeps): Promise<void> {
  const url = ownUrl(data?.link, deps.origin);
  if (!url) return;
  try {
    await deps.openWindow(url.href);
  } catch {
    // the browser refused to open a window; nothing more to do
  }
}
