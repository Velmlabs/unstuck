// Service worker glue (served at the site root as /sw.js). The logic lives in sw-logic.ts.
import { indexedDbDeviceStore } from './device-store';
import { handleClick, notificationFor } from './sw-logic';

interface Ev {
  waitUntil(p: Promise<unknown>): void;
}
interface PushEv extends Ev {
  data: { json(): unknown } | null;
}
interface ClickEv extends Ev {
  notification: { close(): void; data: { link?: unknown } | null };
}
const sw = self as unknown as {
  addEventListener(type: string, fn: (e: never) => void): void;
  registration: { showNotification(title: string, o?: unknown): Promise<void> };
  clients: { openWindow(url: string): Promise<unknown> };
  skipWaiting(): Promise<void>;
};

sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('push', (e: PushEv) => {
  e.waitUntil(
    (async () => {
      let data: unknown = null;
      try {
        data = e.data?.json() ?? null;
      } catch {
        // not JSON: nothing to show
      }
      const n = await notificationFor(data, indexedDbDeviceStore(), self.location.origin);
      await sw.registration.showNotification(n.title, n.options);
    })(),
  );
});
sw.addEventListener('notificationclick', (e: ClickEv) => {
  e.notification.close();
  e.waitUntil(handleClick(e.notification.data, { origin: self.location.origin, openWindow: (u) => sw.clients.openWindow(u) }));
});
