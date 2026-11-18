import { sealAlert, type AlertPayload, type TakeoverStatus } from '@velmlabs/unstuck-protocol';
import type { LinkInfo, TakeoverControl } from '../engine';
import { cleanAgentName } from '../session/agent-name';

export { cleanAgentName };

export interface CloudAlerterOptions {
  /** Unstuck Cloud's API origin, e.g. https://unstuck.sh. */
  apiBase: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** One line per problem; never contains the link secret or the API key. */
  log?: (line: string) => void;
  now?: () => number;
  /** Who is asking, shown on the alert (cleaned; empty means Cloud uses the key's name). */
  agentName?: string;
}

/** Why no phone got the link: the key may not send alerts, no phone is paired, no phone's key could seal it, Cloud refused it. */
export type AlertProblem = 'alerts_not_allowed' | 'no_devices' | 'seal_failed' | 'notify_failed' | 'unauthorized' | 'error';
/** How many paired phones Unstuck Cloud accepted the alert for, or why none. */
export type AlertOutcome = { delivered: number } | { delivered: 0; problem: AlertProblem };
/** A question that opted in with `private: false`: the only text Cloud may read. */
export interface QuickQuestion {
  question: string;
  choices: string[];
}
/** What Cloud is told when an alerted session ends. `byAgent` is all it learns of the detail. */
export interface AlertEnd {
  sessionId: string;
  status: TakeoverStatus;
  durationS: number;
  /** The chosen label of a quick question; never a private question's, never typed text. */
  label?: string;
  /** The agent ended it (`cancelled_by_agent` or `engine_closed`). */
  byAgent?: true;
}
export interface CloudAlerter {
  (info: LinkInfo, site: string | undefined, extra?: { quick?: QuickQuestion }): Promise<AlertOutcome>;
  end?(e: AlertEnd): Promise<void>;
}

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
      if (res.status === 403 && ((await res.json().catch(() => null)) as { error?: string } | null)?.error === 'alerts_not_allowed') {
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

  const agentName = cleanAgentName(o.agentName);

  const alert = async (info: LinkInfo, site: string | undefined, extra?: { quick?: QuickQuestion }): Promise<AlertOutcome> => {
    try {
      const link = splitLink(info.url);
      if (!link) return none('error');
      const list = await devices();
      if (!list) return none('alerts_not_allowed');
      if (list.length === 0) return none('no_devices');
      // For a question the reason IS the question: it travels only inside the sealed payload.
      const payload: AlertPayload = {
        t: link.t,
        k: link.k,
        reason: cut(info.reason, MAX_REASON),
        site: cut(site ?? '', MAX_SITE),
        expiresAt: info.expiresAt,
        ...(info.kind === 'question' ? { mode: 'question' as const, question: info.reason } : info.mode ? { mode: info.mode } : {}),
      };
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
          // Readable by Cloud: never the reason, site, link secret or a private question.
          body: JSON.stringify({
            sessionId: info.sessionId,
            viewerUrl: link.viewerUrl,
            sealed,
            kind: info.kind ?? 'other',
            ...(agentName ? { agentName } : {}),
            expiresAt: info.expiresAt,
            ...(extra?.quick ? { question: extra.quick.question, choices: extra.quick.choices } : {}),
          }),
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

  /** Tells Cloud how an alerted session ended. Never rejects: a failure is one log line. */
  async function end(e: AlertEnd): Promise<void> {
    try {
      const res = await within('end report', (signal) =>
        doFetch(`${base}/api/v1/alerts/end`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: e.sessionId, status: e.status, durationS: e.durationS, ...(e.label !== undefined ? { label: e.label } : {}), ...(e.byAgent ? { byAgent: true } : {}) }),
          signal,
        }),
      );
      if (!res.ok) throw new AlertFailure(`end report answered ${res.status}`, 'error');
    } catch (err) {
      log(`[unstuck] could not send the end report: ${String((err as Error)?.message ?? err).replaceAll(o.apiKey, '***')}`);
    }
  }

  return Object.assign(alert, { end });
}

/** The detail values that mean the agent itself ended the session. */
const BY_AGENT = new Set(['cancelled_by_agent', 'engine_closed']);

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
  /** A question that opted in with `private: false` (its text and choices may go to Cloud; the chosen label too). */
  quick?: QuickQuestion,
): Promise<AlertOutcome> | null {
  if (alerts === false || !alerter) return null;
  const failed = (): AlertOutcome => ({ delivered: 0, problem: 'error' });
  let sent: Promise<AlertOutcome>;
  try {
    sent = Promise.resolve(quick ? alerter(info, site, { quick }) : alerter(info, site)).catch(failed);
  } catch {
    sent = Promise.resolve(failed());
  }
  // Once a phone got the alert, Cloud hears how it ended (never the detail text, never typed text).
  void sent
    .then(async (r) => {
      if (r.delivered === 0 || !alerter.end) return;
      const res = await takeover.ended;
      const label = quick && res.status === 'answered' ? res.answer?.label : undefined;
      await alerter.end({
        sessionId: info.sessionId,
        status: res.status,
        durationS: res.durationS,
        ...(label ? { label: cut(label, 80) } : {}),
        ...(res.detail && BY_AGENT.has(res.detail) ? { byAgent: true as const } : {}),
      });
    })
    .catch(() => {});
  if (alerts === 'required') void sent.then((r) => r.delivered === 0 && !takeover.joined() && takeover.fail('alert_failed'));
  return sent;
}

/**
 * The phone alert for a question session (stdio host, MCP server and in-process SDK alike): kind `question`, no site (a
 * question has no page), and the question text and choices as a quick answer only when the question isn't private and
 * has choices (Cloud rejects a readable question without choices).
 */
export function sendAskAlert(
  alerter: CloudAlerter | null | undefined,
  alerts: boolean | 'required' | undefined,
  info: LinkInfo,
  takeover: TakeoverControl,
  ask: { question: string; choices?: string[]; private?: boolean },
): Promise<AlertOutcome> | null {
  const quick = ask.private === false && ask.choices ? { question: ask.question, choices: ask.choices } : undefined;
  return sendTakeoverAlert(alerter, alerts, { ...info, kind: 'question' }, undefined, takeover, quick);
}
