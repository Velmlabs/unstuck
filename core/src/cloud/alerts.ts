import { sealAlert, type AlertPayload } from '@velmlabs/unstuck-protocol';
import type { LinkInfo, TakeoverControl } from '../engine';

export interface CloudAlerterOptions {
  /** Unstuck Cloud's API origin, e.g. https://unstuck.sh. */
  apiBase: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** One line per problem; never contains the link secret or the API key. */
  log?: (line: string) => void;
  now?: () => number;
}

/** Why no phone got the link: the key may not send alerts, no phone is paired, no phone's key could seal it, Cloud refused it. */
export type AlertProblem = 'alerts_not_allowed' | 'no_devices' | 'seal_failed' | 'notify_failed' | 'unauthorized' | 'error';
/** How many paired phones Unstuck Cloud accepted the alert for, or why none. */
export type AlertOutcome = { delivered: number } | { delivered: 0; problem: AlertProblem };
export type CloudAlerter = (info: LinkInfo, site: string | undefined) => Promise<AlertOutcome>;

/** A failure that already has its outcome (the message is what gets logged). */
class AlertFailure extends Error {
  constructor(
    message: string,
    readonly problem: AlertProblem,
  ) {
    super(message);
  }
}

interface Device {
  id: string;
  publicKey: string;
  label?: string;
}

const CACHE_MS = 60_000;
/** Each call to Unstuck Cloud (devices lookup, notify) gives up after this, so `alerts: 'required'` fails promptly. */
export const ALERT_TIMEOUT_MS = 10_000;
/** The sealed payload's caps (code points): a long reason must not push the link past what push and Telegram carry. */
export const MAX_REASON = 200;
export const MAX_SITE = 253;

const cut = (s: string, n: number) => [...s].slice(0, n).join('');
/** A label as one safe log token: no control, zero-width or bidi characters (Cloud sanitises too), at most 64. */
// eslint-disable-next-line no-control-regex
const logLabel = (d: Device) => cut(String(d.label ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim(), 64) || 'phone';
const logId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);

/** `t` and `k` from a link's `#t=…&k=…` fragment, plus the URL without it; null when it has none. */
function splitLink(url: string): { t: string; k: string; viewerUrl: string } | null {
  const hash = url.indexOf('#');
  if (hash < 0) return null;
  const q = new URLSearchParams(url.slice(hash + 1));
  const t = q.get('t');
  const k = q.get('k');
  return t && k ? { t, k, viewerUrl: url.slice(0, hash) } : null;
}

/**
 * Seals each takeover link to the account's paired phones and asks Unstuck Cloud to deliver it (notifications spec §4.2).
 * Cloud only ever sees ciphertext. Never rejects: an alert that can't be sent is one line on the log, and the outcome
 * says why.
 */
export function createCloudAlerter(o: CloudAlerterOptions): CloudAlerter {
  const base = o.apiBase.replace(/\/+$/, '');
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const log = o.log ?? ((l: string) => console.error(l));
  const now = o.now ?? Date.now;
  const headers = { Authorization: `Bearer ${o.apiKey}` };
  /** Only a successful device list is cached: a refusal or failure is asked again on the next alert (it may be fixed by then). */
  let cache: { at: number; devices: Device[] } | null = null;
  /** The phones the previous alert was sealed to (ids and labels), so the log line appears only when it changes. */
  let lastSet: string | null = null;

  /**
   * Runs one call to Cloud, reading its answer included, within ALERT_TIMEOUT_MS. The race also covers a custom fetch
   * that ignores the abort signal (plain setTimeout + AbortController: works in workerd and with fake timers).
   */
  async function within<T>(what: string, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new AlertFailure(`${what} took longer than ${ALERT_TIMEOUT_MS / 1000} s`, 'error'));
      }, ALERT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([call(ac.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The paired phones, or null when the key may not send alerts (403 alerts_not_allowed). */
  async function devices(): Promise<Device[] | null> {
    if (cache && now() - cache.at < CACHE_MS) return cache.devices;
    const list = await within('devices lookup', async (signal) => {
      const res = await doFetch(`${base}/api/v1/agent/devices`, { headers, signal });
      if (res.status === 403 && (await res.json().catch(() => null))?.error === 'alerts_not_allowed') {
        log('[unstuck] alerts are not enabled for this API key (turn them on in your unstuck.sh dashboard)');
        return null;
      }
      if (!res.ok) throw new AlertFailure(`devices lookup answered ${res.status}`, res.status === 401 ? 'unauthorized' : 'error');
      return ((await res.json()) as { devices: Device[] }).devices;
    });
    if (list) cache = { at: now(), devices: list };
    return list;
  }

  const none = (problem: AlertProblem): AlertOutcome => ({ delivered: 0, problem });

  return async (info, site) => {
    try {
      const link = splitLink(info.url);
      if (!link) return none('error');
      const list = await devices();
      if (!list) return none('alerts_not_allowed');
      if (list.length === 0) return none('no_devices');
      const payload: AlertPayload = { t: link.t, k: link.k, reason: cut(info.reason, MAX_REASON), site: cut(site ?? '', MAX_SITE), expiresAt: info.expiresAt };
      // Each phone on its own: one with a bad key is skipped, the others still get the alert.
      const results = await Promise.all(
        list.map(async (d) => {
          try {
            return { d, blob: await sealAlert(d.publicKey, d.id, info.sessionId, payload) };
          } catch {
            log(`[unstuck] skipped phone ${logLabel(d)} (${logId(d.id)}): its key is not valid`);
            return null;
          }
        }),
      );
      const ok = results.filter((r): r is { d: Device; blob: string } => r !== null);
      if (ok.length === 0) return none('seal_failed');
      const named = ok.map((r) => `${logLabel(r.d)} (${logId(r.d.id)})`).join(', ');
      if (named !== lastSet) {
        lastSet = named;
        log(`[unstuck] alert sealed to ${ok.length} phone(s): ${named}`);
      }
      const sealed = ok.map((r) => ({ device: r.d.id, blob: r.blob }));
      const res = await within('notify', (signal) =>
        doFetch(`${base}/api/v1/agent/notify`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: info.sessionId, viewerUrl: link.viewerUrl, sealed }),
          signal,
        }),
      );
      if (!res.ok) throw new AlertFailure(`notify answered ${res.status}`, res.status === 401 ? 'unauthorized' : 'notify_failed');
      return { delivered: ok.length };
    } catch (e) {
      // The message can come from fetch internals; the API key and link secret are never part of what we build here.
      log(`[unstuck] could not send the phone alert: ${String((e as Error)?.message ?? e).replaceAll(o.apiKey, '***')}`);
      return none(e instanceof AlertFailure ? e.problem : 'error');
    }
  };
}

/**
 * A takeover's alert, from its link handler: none with `alerts: false`; with `'required'`, a link that reached no paired
 * phone fails the takeover at once with `alert_failed` instead of letting it wait for its timeout, unless someone already
 * joined through the link the handler passed on. An alerter that rejects counts as no phone reached.
 * Returns the outcome (never rejects), or null when no alert is sent (no Unstuck Cloud alerter, or `alerts: false`).
 */
export function sendTakeoverAlert(
  alerter: CloudAlerter | null | undefined,
  alerts: boolean | 'required' | undefined,
  info: LinkInfo,
  site: string | undefined,
  takeover: TakeoverControl,
): Promise<AlertOutcome> | null {
  if (alerts === false || !alerter) return null;
  const failed = (): AlertOutcome => ({ delivered: 0, problem: 'error' });
  let sent: Promise<AlertOutcome>;
  try {
    sent = Promise.resolve(alerter(info, site)).catch(failed);
  } catch {
    sent = Promise.resolve(failed());
  }
  if (alerts === 'required') void sent.then((r) => r.delivered === 0 && !takeover.joined() && takeover.fail('alert_failed'));
  return sent;
}
