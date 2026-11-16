/*
 * "Install Unstuck" on the pair page. Chrome (Android, desktop) fires `beforeinstallprompt` once per page load, early,
 * when the site is installable; if nobody keeps that event, its own mini-infobar is the only way in, and once ignored
 * it doesn't come back for a while. So the pair entry module captures it before anything renders (preventDefault keeps
 * the infobar away; the page offers its own button instead) and the page calls `prompt()` when the person asks.
 * An event can prompt once: after a dismissal the button goes until the browser fires a new one (the next load).
 */

export interface InstallPromptEvent extends Event {
  prompt(): Promise<unknown>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

export interface Installer {
  /** The browser offered an install prompt that hasn't been used yet. */
  available(): boolean;
  /** Running as the installed app, or installed during this page load. */
  installed(): boolean;
  /** Shows the browser's install prompt; the event is spent either way. */
  prompt(): Promise<InstallOutcome>;
  /** Calls `fn` whenever available() or installed() may have changed; returns an unsubscribe. */
  subscribe(fn: () => void): () => void;
}

type Win = Pick<Window, 'addEventListener'> & { matchMedia?: (q: string) => { matches: boolean } };

/** Starts listening at once: call it from the entry module, before the first render. */
export function captureInstall(win: Win, nav: { standalone?: boolean } = {}): Installer {
  let deferred: InstallPromptEvent | null = null;
  let appInstalled = false;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());
  win.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    changed();
  });
  win.addEventListener('appinstalled', () => {
    appInstalled = true;
    deferred = null;
    changed();
  });
  const standalone = () => nav.standalone === true || (typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches);
  return {
    available: () => deferred !== null,
    installed: () => appInstalled || standalone(),
    async prompt() {
      const e = deferred;
      if (!e) return 'unavailable';
      deferred = null; // a prompt event works once: the button goes as soon as it is used
      changed();
      try {
        await e.prompt();
        const { outcome } = await e.userChoice;
        return outcome;
      } catch {
        return 'unavailable';
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
