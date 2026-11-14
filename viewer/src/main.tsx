import { render } from 'preact';
import { App } from './App';
import { takeFragment } from './url';
import './styles.css';

const noStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
let tab: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = noStorage;
try {
  tab = window.sessionStorage;
} catch {
  // storage blocked: the fragment still leaves the address bar
}
const { pathname, origin } = window.location;
const hash = takeFragment(window.location, tab, window.history);
render(<App location={{ hash, pathname, origin }} />, document.getElementById('app')!);
