import { openAlertLink } from './alert-link';
import type { DeviceStore } from './device-store';

export interface SwDeps {
  openWindow(url: string): Promise<unknown>;
}

export interface ShownNotification {
  title: string;
  options: { body: string; data: { link?: string } };
}

const GENERIC = 'Your agent needs you';

function webUrl(v: unknown): URL | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * What a push payload (`{kind:'takeover', link, keyName}` or `{kind:'test'}`) shows. A takeover's reason and site are
 * unsealed on this phone from the link's own `#x=…`; when that fails the notification is still shown, without them.
 */
export async function notificationFor(data: unknown, store: DeviceStore): Promise<ShownNotification | null> {
  const d = data as { kind?: unknown; link?: unknown; keyName?: unknown } | null;
  if (!d || typeof d !== 'object') return null;
  if (d.kind === 'test') return { title: 'Test alert from Unstuck', options: { body: '', data: {} } };
  if (d.kind !== 'takeover') return null;
  const url = webUrl(d.link);
  if (!url) return null;
  const link = url.href;
  let title = GENERIC;
  try {
    const opened = await openAlertLink(url.hash, url.pathname, store);
    if (!('error' in opened)) title = `${GENERIC}: ${opened.reason}${opened.site ? ` · ${opened.site}` : ''}`;
  } catch {
    // unreadable here: the generic title still tells the person to look
  }
  const key = typeof d.keyName === 'string' ? d.keyName : '';
  return { title, options: { body: key ? `Sent by key: ${key}` : '', data: { link } } };
}

/** Opens the notification's link; a test alert (no link) does nothing. */
export async function handleClick(data: { link?: unknown } | null | undefined, deps: SwDeps): Promise<void> {
  const url = webUrl(data?.link);
  if (!url) return;
  try {
    await deps.openWindow(url.href);
  } catch {
    // the browser refused to open a window; nothing more to do
  }
}
