import { useEffect, useState } from 'preact/hooks';
import { exportDevicePublicKey, newDeviceKeyPair } from '@velmlabs/unstuck-protocol';
import type { DeviceRecord, DeviceStore } from '../device-store';
import { defaultLabel, normalizeCode, pushNeedsHomeScreen } from './env';

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
}

type Phase = 'loading' | 'ready' | 'pairing' | 'paired' | 'expired' | 'rejected' | 'unreachable';
type Note = { kind: 'ok' | 'error'; text: string } | null;

const EXPIRED = 'This pairing code has expired. Make a new one in your dashboard.';
const REJECTED = 'Could not pair this phone. Make a new code in your dashboard and try again.';

export function Pair({ code, apiBase, pathname, search, store, history, env, fetchFn, subscribePush, openUrl }: PairProps) {
  const doFetch = fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const [phase, setPhase] = useState<Phase>('loading');
  const [label, setLabel] = useState(() => defaultLabel(env.userAgent, env.standalone, env.maxTouchPoints));
  const [device, setDevice] = useState<DeviceRecord | null>(null);
  const [pushNote, setPushNote] = useState<Note>(null);
  const [tgNote, setTgNote] = useState<Note>(null);
  const [typed, setTyped] = useState('');
  const [codeError, setCodeError] = useState(false);

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
        setPhase(code || !rec ? 'ready' : 'paired');
      },
      () => setPhase('ready'),
    );
  }, []);

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
      const rec = { deviceId: body.deviceId, privateKey: kp.privateKey, deviceToken: body.deviceToken };
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
      setPushNote({ kind: 'ok', text: 'Phone notifications are on.' });
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

  return (
    <main class="message-card pair">
      <h1>Pair this phone</h1>
      {phase === 'loading' && <p role="status">One moment…</p>}
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
          <p role="status">This phone is paired. Clearing this browser's site data unpairs it.</p>
          {needsHome && homeScreenSteps}
          {!needsHome && env.canPush && (
            <section>
              <button type="button" class="btn pair-btn" onClick={() => void turnOnPush()}>Turn on phone notifications</button>
              {pushNote && <p role={pushNote.kind === 'error' ? 'alert' : 'status'}>{pushNote.text}</p>}
            </section>
          )}
          <section>
            <button type="button" class="btn pair-btn" onClick={() => void connectTelegram()}>Connect Telegram</button>
            <p>
              Tip: in Telegram, open Settings, Chat Settings and turn off "In-App Browser", so links from the bot open in this browser.
            </p>
            {tgNote && <p role="alert">{tgNote.text}</p>}
          </section>
        </>
      )}
    </main>
  );
}
