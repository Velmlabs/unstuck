import { useEffect, useRef, useState } from 'preact/hooks';
import { exportDevicePublicKey, newDeviceKeyPair } from '@velmlabs/unstuck-protocol';
import type { DeviceRecord, DeviceStore } from '../device-store';
import { defaultLabel, normalizeCode, pushNeedsHomeScreen } from './env';
import type { Installer } from './install';
import { InstallIcon } from '../icons';

export interface PairEnv {
  userAgent: string;
  /** `navigator.standalone`: running as the iPhone home-screen app. */
  standalone: boolean;
  maxTouchPoints: number;
  /** This browser has service workers, Push and Notification. */
  canPush: boolean;
}

export interface PairProps {
  /** The one-time code from `#c=`; null when the page was opened without one. */
  code: string | null;
  apiBase: string;
  pathname: string;
  search: string;
  store: DeviceStore;
  history: { replaceState(data: unknown, unused: string, url: string): void };
  env: PairEnv;
  fetchFn?: typeof fetch;
  /** Asks permission, registers the service worker and subscribes; resolves with the subscription's JSON. */
  subscribePush: (vapidPublicKey: string) => Promise<unknown>;
  openUrl: (url: string) => void;
  /** The install prompt captured by the entry module (see install.ts); left out, no install option is shown. */
  install?: Installer;
}

/** What Cloud says is really set up for this phone (GET /api/v1/devices/self). */
type Status = { push: boolean; telegram: boolean; telegramAnyBrowser: boolean };

type Phase = 'loading' | 'confirm' | 'ready' | 'pairing' | 'paired' | 'expired' | 'rejected' | 'unreachable';
type Note = { kind: 'ok' | 'error'; text: string } | null;

const EXPIRED = 'This pairing code has expired. Make a new one in your dashboard.';
const REJECTED = 'Could not pair this phone. Make a new code in your dashboard and try again.';
const ANY_BROWSER_COPY =
  'Telegram links then carry the key that opens them, so Unstuck Cloud, Telegram and anyone you forward the message to could open your takeovers. Phone notifications stay locked to this browser.';

function parseStatus(v: unknown): Status | null {
  const s = v as Partial<Status> | null;
  if (!s || typeof s.push !== 'boolean' || typeof s.telegram !== 'boolean' || typeof s.telegramAnyBrowser !== 'boolean') return null;
  return { push: s.push, telegram: s.telegram, telegramAnyBrowser: s.telegramAnyBrowser };
}

export function Pair({ code, apiBase, pathname, search, store, history, env, fetchFn, subscribePush, openUrl, install }: PairProps) {
  const doFetch = fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const [phase, setPhase] = useState<Phase>('loading');
  const [label, setLabel] = useState(() => defaultLabel(env.userAgent, env.standalone, env.maxTouchPoints));
  const [device, setDevice] = useState<DeviceRecord | null>(null);
  const [pushNote, setPushNote] = useState<Note>(null);
  const [tgNote, setTgNote] = useState<Note>(null);
  const [typed, setTyped] = useState('');
  const [codeError, setCodeError] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [anyNote, setAnyNote] = useState<Note>(null);
  // Only the latest status answer applies: every read and every toggle takes a new number.
  const seq = useRef(0);
  const reading = useRef(false);
  /** Re-render when the browser offers (or spends) its install prompt, or the app gets installed. */
  const [, setInstallTick] = useState(0);
  const [showSteps, setShowSteps] = useState(false);
  useEffect(() => install?.subscribe(() => setInstallTick((n) => n + 1)), []);

  useEffect(() => {
    // The code is a credential: it leaves the address bar (and so history and sync) as soon as it is read.
    if (code) {
      try {
        history.replaceState(null, '', pathname + search);
      } catch {
        // keep going with it in the address bar
      }
    }
    store.get().then(
      (rec) => {
        setDevice(rec);
        // A code while already paired: ask before replacing the pairing (the old device would keep getting alerts).
        setPhase(!rec ? 'ready' : code ? 'confirm' : 'paired');
      },
      () => setPhase('ready'),
    );
  }, []);

  // Once paired: what is really set up, on mount and whenever the page is shown again (back from Telegram, or from
  // the back/forward cache). A failed load keeps the last known state (at first: today's buttons, no warning).
  const token = phase === 'paired' ? device?.deviceToken : undefined;
  useEffect(() => {
    if (!token) return;
    let live = true;
    const load = async () => {
      if (reading.current) return; // one read at a time
      reading.current = true;
      const mine = ++seq.current;
      try {
        const res = await doFetch(`${apiBase}/api/v1/devices/self`, { headers: { Authorization: `Bearer ${token}` } });
        const next = res.ok ? parseStatus(await res.json()) : null;
        if (live && next && mine === seq.current) setStatus(next);
      } catch {
        // offline: keep what is shown
      } finally {
        reading.current = false;
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    // Back/forward cache restores only: a normal load already ran the read above.
    const onShow = (e: Event) => {
      if ((e as PageTransitionEvent).persisted) void load();
    };
    void load();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onShow);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onShow);
    };
  }, [token]);

  async function pair() {
    const pairingCode = code ?? normalizeCode(typed);
    if (!pairingCode) return setCodeError(true);
    setCodeError(false);
    setPhase('pairing');
    try {
      const kp = await newDeviceKeyPair();
      const publicKey = await exportDevicePublicKey(kp.publicKey);
      const res = await doFetch(`${apiBase}/api/v1/devices/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pairingCode, publicKey, label: label.trim() || defaultLabel(env.userAgent, env.standalone, env.maxTouchPoints) }),
      });
      if (res.status === 404 || res.status === 410) return setPhase('expired');
      if (res.status === 400) return setPhase('rejected');
      if (!res.ok) return setPhase('unreachable');
      const body = (await res.json()) as { deviceId: string; deviceToken: string };
      const name = label.trim() || defaultLabel(env.userAgent, env.standalone, env.maxTouchPoints);
      const rec: DeviceRecord = { deviceId: body.deviceId, privateKey: kp.privateKey, deviceToken: body.deviceToken, apiBase, label: name };
      // Paired again: the old device goes, with its own token, so it stops getting (and duplicating) alerts.
      if (device) {
        try {
          await doFetch(`${apiBase}/api/v1/devices/self`, { method: 'DELETE', headers: { Authorization: `Bearer ${device.deviceToken}` } });
        } catch {
          // offline: the old device stays listed in the dashboard, where it can be removed
        }
      }
      await store.put(rec);
      setDevice(rec);
      setPhase('paired');
    } catch {
      setPhase('unreachable');
    }
  }

  const auth = () => ({ Authorization: `Bearer ${device!.deviceToken}`, 'Content-Type': 'application/json' });

  async function turnOnPush() {
    setPushNote(null);
    try {
      const v = await doFetch(`${apiBase}/api/v1/push/vapid`);
      if (!v.ok) throw new Error('vapid');
      const { publicKey } = (await v.json()) as { publicKey: string };
      const subscription = await subscribePush(publicKey);
      const res = await doFetch(`${apiBase}/api/v1/devices/self/push`, { method: 'PUT', headers: auth(), body: JSON.stringify({ subscription }) });
      if (!res.ok) throw new Error('push');
      setStatus((s) => ({ telegram: false, telegramAnyBrowser: false, ...s, push: true }));
    } catch {
      setPushNote({ kind: 'error', text: 'Could not turn on phone notifications. Check that notifications are allowed for this site, then try again.' });
    }
  }

  async function connectTelegram() {
    setTgNote(null);
    try {
      const res = await doFetch(`${apiBase}/api/v1/devices/self/telegram`, { method: 'POST', headers: auth() });
      if (!res.ok) throw new Error('telegram');
      const { url } = (await res.json()) as { url: string };
      if (!/^https:\/\/t\.me\//.test(url)) throw new Error('not a Telegram link');
      openUrl(url);
    } catch {
      setTgNote({ kind: 'error', text: 'Could not start Telegram. Try again.' });
    }
  }

  async function setAnyBrowser(enabled: boolean) {
    setAnyNote(null);
    const mine = ++seq.current; // a status read still in flight no longer applies
    try {
      const res = await doFetch(`${apiBase}/api/v1/devices/self/telegram-any-browser`, { method: 'PUT', headers: auth(), body: JSON.stringify({ enabled }) });
      const next = res.ok ? parseStatus(await res.json()) : null;
      if (!next) throw new Error('any-browser');
      if (mine === seq.current) setStatus(next);
    } catch {
      setAnyNote({ kind: 'error', text: 'Could not change this setting. Try again.' });
    }
  }

  const needsHome = pushNeedsHomeScreen(env.userAgent, env.standalone, env.maxTouchPoints);
  const pairText = needsHome ? 'Pair Safari (for Telegram and email links)' : 'Pair this phone';
  const homeScreenSteps = (
    <section>
      <h2>Add to Home Screen for phone notifications</h2>
      <p>
        iPhone only shows notifications for apps on the Home Screen. Tap Share, then Add to Home Screen, then open Unstuck from the Home Screen and enter a new pairing code from your dashboard. This does not use the code on this page.
      </p>
    </section>
  );

  const INSTALL_COPY = 'Installs Unstuck as an app, so takeover links and notifications open in it.';
  const HOME_SCREEN_COPY = 'Adds Unstuck to your Home Screen so it can show phone notifications (pair it again there).';
  // "Installed" is said on a phone only (a computer's installed app needs no word here).
  const onPhone = env.maxTouchPoints > 0;
  const installButton = (onClick: () => void, expanded?: boolean) => (
    <button type="button" class="btn pair-btn install-btn" aria-expanded={expanded} onClick={onClick}>
      <InstallIcon />
      Install Unstuck
    </button>
  );
  // Installed (the home-screen app, or Chrome's installed app): say so on a phone. Chrome offered a prompt: the button
  // opens it. iPhone and iPad Safari have no prompt: the button shows the Share → Add to Home Screen steps. Elsewhere:
  // nothing.
  const installed = env.standalone || !!install?.installed();
  const installSection = installed ? (
    onPhone ? (
      <section>
        <p role="status">Unstuck is installed on this phone.</p>
      </section>
    ) : null
  ) : install?.available() ? (
    <section>
      {installButton(() => void install.prompt())}
      <p class="muted">{INSTALL_COPY}</p>
    </section>
  ) : needsHome ? (
    <section>
      {installButton(() => setShowSteps((v) => !v), showSteps)}
      <p class="muted">{HOME_SCREEN_COPY}</p>
      {showSteps && homeScreenSteps}
    </section>
  ) : null;

  return (
    <main class="message-card pair">
      <h1>Pair this phone</h1>
      {phase === 'loading' && <p role="status">One moment…</p>}
      {phase === 'confirm' && (
        <>
          <p>{device?.label ? `This browser is already paired as ${device.label}. Pair it again?` : 'This browser is already paired. Pair it again?'}</p>
          <button type="button" class="btn pair-btn" onClick={() => setPhase('ready')}>Pair again</button>
          <button type="button" class="btn btn-ghost pair-btn" onClick={() => setPhase('paired')}>Keep current</button>
        </>
      )}
      {phase === 'expired' && <p role="alert">{EXPIRED}</p>}
      {phase === 'rejected' && <p role="alert">{REJECTED}</p>}
      {phase === 'unreachable' && (
        <>
          <p role="alert">Could not reach Unstuck. Check your connection and try again.</p>
          <button type="button" class="btn pair-btn" onClick={() => void pair()}>{pairText}</button>
        </>
      )}
      {(phase === 'ready' || phase === 'pairing') && (
        <>
          <p>Your agent's takeover links will be sent to this phone, and only this phone can open them.</p>
          {!code && (
            <>
              <label for="pair-code">Enter the pairing code from your dashboard</label>
              <input id="pair-code" type="text" inputMode="text" autocapitalize="characters" autocomplete="off" placeholder="ABCD-EFGH" value={typed} maxLength={12} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} />
              {codeError && <p role="alert">That code does not look right. It is 8 letters and numbers, like ABCD-EFGH.</p>}
            </>
          )}
          <label for="pair-label">Name for this phone</label>
          <input id="pair-label" type="text" value={label} maxLength={60} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} />
          <button type="button" class="btn pair-btn" disabled={phase === 'pairing'} onClick={() => void pair()}>{pairText}</button>
          {needsHome && homeScreenSteps}
        </>
      )}
      {phase === 'paired' && (
        <>
          <p role="status">{device?.label ? `This phone is paired as ${device.label}.` : 'This phone is paired.'} Clearing this browser's site data unpairs it.</p>
          {installSection}
          {!needsHome && env.canPush && (
            <section>
              {status?.push && <p role="status">Phone notifications are on.</p>}
              <button type="button" class="btn pair-btn" onClick={() => void turnOnPush()}>{status?.push ? 'Turn on again' : 'Turn on phone notifications'}</button>
              {pushNote && <p role={pushNote.kind === 'error' ? 'alert' : 'status'}>{pushNote.text}</p>}
            </section>
          )}
          <section>
            {status?.telegram ? (
              <>
                <p role="status">Telegram is connected: alerts for this phone arrive in your Telegram chat.</p>
                <button type="button" class="btn btn-ghost pair-btn btn-small" onClick={() => void connectTelegram()}>Reconnect Telegram</button>
                <label class="toggle">
                  <input type="checkbox" checked={status.telegramAnyBrowser} onChange={() => void setAnyBrowser(!status.telegramAnyBrowser)} /> Telegram links open in any browser
                </label>
                <p class="muted">{ANY_BROWSER_COPY}</p>
                {anyNote && <p role="alert">{anyNote.text}</p>}
              </>
            ) : (
              <button type="button" class="btn pair-btn" onClick={() => void connectTelegram()}>Connect Telegram</button>
            )}
            {!status?.telegramAnyBrowser && (
              <p>
                Tip: in Telegram, open Settings, Chat Settings and turn off "In-App Browser", so links from the bot open in this browser.
              </p>
            )}
            {tgNote && <p role="alert">{tgNote.text}</p>}
          </section>
        </>
      )}
    </main>
  );
}
