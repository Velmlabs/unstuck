import { render } from 'preact';
import { b64urlDecode } from '@velmlabs/unstuck-protocol';
import { indexedDbDeviceStore } from '../device-store';
import { Pair } from './Pair';
import { apiBaseFor, codeFromHash } from './env';
import { captureInstall } from './install';
import '../styles.css';

const nav = navigator as Navigator & { standalone?: boolean };
// First, before anything renders: Chrome fires its install prompt once, early, and only a kept event can be shown later.
const install = captureInstall(window, nav);
const canPush = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function subscribePush(vapidPublicKey: string): Promise<unknown> {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('notifications not allowed');
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlDecode(vapidPublicKey)! as BufferSource }));
  return sub.toJSON();
}

const { hash, pathname, search, hostname } = window.location;
render(
  <Pair
    code={codeFromHash(hash)}
    apiBase={apiBaseFor(hostname, search)}
    pathname={pathname}
    search={search}
    store={indexedDbDeviceStore()}
    history={window.history}
    env={{ userAgent: navigator.userAgent, standalone: nav.standalone === true, maxTouchPoints: navigator.maxTouchPoints ?? 0, canPush }}
    subscribePush={subscribePush}
    openUrl={(u) => window.location.assign(u)}
    install={install}
  />,
  document.getElementById('app')!,
);
