import { render } from 'preact';
import { b64urlDecode } from '@velmlabs/unstuck-protocol';
import { indexedDbDeviceStore } from '../device-store';
import { Pair } from './Pair';
import { apiBaseFor, codeFromHash } from './env';
import '../styles.css';

const nav = navigator as Navigator & { standalone?: boolean };
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
  />,
  document.getElementById('app')!,
);
