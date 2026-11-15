import { render } from 'preact';
import { App, type AppProps } from './App';
import { apiBaseForAlerts, checkSender, openAlertLinkSafely } from './alert-link';
import { indexedDbDeviceStore } from './device-store';
import { sessionIdFromPath, takeFragment } from './url';
import { parseAlertFragment } from '@velmlabs/unstuck-protocol';
import './styles.css';

const noStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
let tab: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = noStorage;
try {
  tab = window.sessionStorage;
} catch {
  // storage blocked: the fragment still leaves the address bar
}

const mount = () => document.getElementById('app')!;

/** A sealed link this browser can't open: the #x leaves the address bar and the paired-phone page is shown. */
function showAlertError(error: NonNullable<AppProps['alertError']>) {
  const { pathname, origin, search } = window.location;
  try {
    window.history.replaceState(null, '', pathname + search);
  } catch {
    // keep going
  }
  render(<App location={{ hash: '', pathname, origin, search }} alertError={error} />, mount());
}

async function start() {
  const { pathname, origin, search, hostname } = window.location;
  let loc = window.location as { hash: string; pathname: string; search: string };
  let extra: Pick<AppProps, 'alert' | 'alertError'> = {};
  // A sealed link (#x=…): unseal it with this phone's key, then carry on exactly as with #t=…&k=… (the plain
  // secret lives only in memory and in this tab's sessionStorage, never in the address bar).
  if (parseAlertFragment(window.location.hash)) {
    const opened = await openAlertLinkSafely(window.location.hash, pathname, indexedDbDeviceStore());
    if ('error' in opened) return showAlertError(opened.error);
    loc = { hash: opened.hash, pathname, search };
    const sessionId = sessionIdFromPath(pathname)!;
    const apiBase = apiBaseForAlerts(hostname, opened);
    extra = { alert: { reason: opened.reason, site: opened.site, sender: () => checkSender({ apiBase, deviceToken: opened.deviceToken, sessionId }) } };
  }
  const hash = takeFragment(loc, tab, window.history);
  render(<App location={{ hash, pathname, origin, search }} {...extra} />, mount());
}

const sealed = parseAlertFragment(window.location.hash) !== null;
start().catch(() => {
  // Never a blank page: whatever failed, a sealed link shows the paired-phone page without its #x.
  if (sealed) showAlertError('no_device');
});
