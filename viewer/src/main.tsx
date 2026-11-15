import { render } from 'preact';
import { App, type AppProps } from './App';
import { openAlertLink } from './alert-link';
import { indexedDbDeviceStore } from './device-store';
import { takeFragment } from './url';
import { parseAlertFragment } from '@velmlabs/unstuck-protocol';
import './styles.css';

const noStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
let tab: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = noStorage;
try {
  tab = window.sessionStorage;
} catch {
  // storage blocked: the fragment still leaves the address bar
}

async function start() {
  const { pathname, origin, search } = window.location;
  let loc = window.location as { hash: string; pathname: string; search: string };
  let extra: Pick<AppProps, 'alert' | 'alertError'> = {};
  // A sealed link (#x=…): unseal it with this phone's key, then carry on exactly as with #t=…&k=… (the plain
  // secret lives only in memory and in this tab's sessionStorage, never in the address bar).
  if (parseAlertFragment(window.location.hash)) {
    const opened = await openAlertLink(window.location.hash, pathname, indexedDbDeviceStore());
    if ('error' in opened) {
      window.history.replaceState(null, '', pathname + search);
      render(<App location={{ hash: '', pathname, origin, search }} alertError={opened.error} />, document.getElementById('app')!);
      return;
    }
    loc = { hash: opened.hash, pathname, search };
    extra = { alert: { reason: opened.reason, site: opened.site } };
  }
  const hash = takeFragment(loc, tab, window.history);
  render(<App location={{ hash, pathname, origin, search }} {...extra} />, document.getElementById('app')!);
}
void start();
