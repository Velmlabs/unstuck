import type { AlertKind, AskParams } from '@velmlabs/unstuck-protocol';
import { checkAsk } from '@velmlabs/unstuck-core';
import { UnstuckConfigError } from './errors';

export interface TakeoverLink {
  url: string;
  reason: string;
  sessionId: string;
  expiresAt: number;
  /** The 6-digit code to give the human, when the takeover requires one. Never part of `url`. */
  code?: string;
}

export interface TakeoverOptions {
  reason: string;
  timeoutS?: number;
  requireCode?: boolean;
  /**
   * The human can only navigate the page within its own site (example.com and its subdomains). List any other
   * sites the flow needs, e.g. ['accounts.google.com'] for a Google sign-in or a 3-D Secure provider.
   */
  allowedSites?: string[];
  /**
   * With Unstuck Cloud, the link is also sent to your paired phones; false skips that for this takeover (default true).
   * 'required': with Unstuck Cloud, end the takeover at once with status `failed`, detail `alert_failed`, if Unstuck
   * Cloud can't accept the link for at least one paired phone (alerts not allowed for the key, no paired phone, every
   * seal failed, or notify answered non-2xx). Without Unstuck Cloud (a self-hosted relay) it throws UnstuckConfigError.
   */
  alerts?: boolean | 'required';
  /** `approval`: the person only confirms a sign-in on their own device, without controlling the page (wrap() sets it). Default `control`. */
  mode?: 'control' | 'approval';
  /** What the phone alert says this is about (default `other`; wrap() sets it from the check). */
  kind?: AlertKind;
}

/** What `ask()` takes. Limits: 2-6 choices of at most 80 characters, a question of at most 300, details of at most 1000. */
export interface AskOptions {
  /** 2-6 labels to pick from. Without choices the person types an answer. */
  choices?: string[];
  /** Let the person type an answer (default true without choices, false with choices). */
  allowText?: boolean;
  /**
   * Keep the question and the answer from Unstuck Cloud (default true). Only a question with `private: false` and choices
   * may be answered with a button on the phone alert, and Cloud then sees the question, the choices and the chosen label.
   */
  private?: boolean;
  /** More to read before answering (at most 1000 characters). */
  details?: string;
  /** Seconds to wait for an answer, 10-3600 (default 600). */
  timeoutS?: number;
  /** Called with the link to the question page; defaults to the `onLink` option, then to the default printer. */
  onLink?: (link: TakeoverLink) => void;
}

export interface UnstuckOptions {
  /** Node only: path to the engine binary. */
  enginePath?: string;
  /** Node only: host the engine's local server binds to. */
  host?: string;
  /** Node only: port the engine's local server binds to. */
  port?: number;
  /** Default takeover timeout in seconds (engine default: 600). */
  timeoutS?: number;
  /** How long wrap() waits for a person to approve a sign-in, in seconds (default 300). */
  approvalTimeoutS?: number;
  /** The name phone alerts and the question page show for this agent (UNSTUCK_AGENT_NAME); at most 40 characters. */
  agentName?: string;
  /**
   * Called when a human is needed. Default: binary mode prints the link to stderr. In-process mode uses console.log: with
   * Unstuck Cloud phone alerts on, it waits for the alert and logs the link only if no paired phone got it (otherwise one
   * line without the link); with a self-hosted relay or `alerts: false` it logs the link. A handler that throws (or
   * returns a promise that rejects) is logged without the link, and the takeover goes on.
   */
  onLink?: (link: TakeoverLink) => void;
  /** Relay to use instead of the local server, e.g. wss://relay.example.com (or set UNSTUCK_RELAY_URL); ws:// only to localhost. */
  relay?: string;
  /** Key for that relay (or UNSTUCK_AGENT_KEY). With only UNSTUCK_API_KEY set, Unstuck Cloud is used. */
  agentKey?: string;
  /** Ask the human for a 6-digit code delivered with the link (default false). */
  requireCode?: boolean;
  /** Unstuck Cloud API key. Takes precedence over UNSTUCK_RELAY_URL / UNSTUCK_AGENT_KEY in the environment; not combinable with `relay`. */
  apiKey?: string;
  /** Override the Unstuck Cloud relay URL (only with apiKey). */
  cloudRelay?: string;
  /** Override the Unstuck Cloud API URL (only with apiKey). */
  cloudApi?: string;
  /** Override the viewer URL used in takeover links (https://, or http:// to localhost). */
  viewerUrl?: string;
  /** 'binary' runs the engine as a child process (Node); 'in-process' runs it in this JavaScript runtime. */
  mode?: 'binary' | 'in-process';
  /** fetch implementation, for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `secure` (wss: or https:) anywhere; the plain scheme (ws: or http:) only to this machine. */
function checkUrl(name: string, value: string | undefined, secure: 'wss' | 'https', plain: 'ws' | 'http'): void {
  if (!value) return; // unset (an empty string is unset too, as elsewhere)
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    // reported below
  }
  if (url?.protocol === `${secure}:` || (url?.protocol === `${plain}:` && LOCAL_HOSTS.has(url.hostname))) return;
  throw new UnstuckConfigError(`${name} must be a ${secure}:// URL (${plain}:// only to localhost, 127.0.0.1 or [::1])`);
}

export function validateOptions(o: UnstuckOptions): void {
  if (o.apiKey && o.relay) throw new UnstuckConfigError('use either apiKey (Unstuck Cloud) or relay + agentKey (your own relay), not both');
  if (o.apiKey && o.agentKey) throw new UnstuckConfigError('agentKey is for your own relay (with relay); Unstuck Cloud only needs apiKey');
  if ((o.cloudRelay || o.cloudApi) && !o.apiKey) throw new UnstuckConfigError('cloudRelay and cloudApi only apply with apiKey');
  checkUrl('relay', o.relay, 'wss', 'ws');
  checkUrl('cloudRelay', o.cloudRelay, 'wss', 'ws');
  checkUrl('cloudApi', o.cloudApi, 'https', 'http');
  checkUrl('viewerUrl', o.viewerUrl, 'https', 'http');
}

/** Engine environment for the options. A value of undefined means "remove this variable". */
export function optionEnv(o: UnstuckOptions): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  if (o.apiKey) {
    env.UNSTUCK_API_KEY = o.apiKey;
    // The apiKey option beats a relay configured in the environment.
    env.UNSTUCK_RELAY_URL = undefined;
    env.UNSTUCK_AGENT_KEY = undefined;
  }
  if (o.cloudRelay) env.UNSTUCK_CLOUD_URL = o.cloudRelay;
  if (o.cloudApi) env.UNSTUCK_CLOUD_API = o.cloudApi;
  if (o.viewerUrl) env.UNSTUCK_VIEWER_URL = o.viewerUrl;
  if (o.relay) env.UNSTUCK_RELAY_URL = o.relay;
  if (o.agentKey) env.UNSTUCK_AGENT_KEY = o.agentKey;
  if (o.agentName) env.UNSTUCK_AGENT_NAME = o.agentName;
  return env;
}

/** `text` with the link, its fragment and each fragment value (the token, the key, ...) replaced, longest first. */
function redactLink(text: string, url: string): string {
  const hash = url.indexOf('#');
  const fragment = hash < 0 ? '' : url.slice(hash + 1);
  const values = [...new URLSearchParams(fragment).values()].filter(Boolean).sort((a, b) => b.length - a.length);
  let out = text.replaceAll(url, '<link>');
  if (fragment) out = out.replaceAll(fragment, '<link secret>');
  for (const v of values) out = out.replaceAll(v, '<link secret>');
  return out;
}

/**
 * A user link handler that throws, or returns a promise that rejects, must not stop the takeover (nor crash Node with an
 * unhandled rejection): one line, without the link (its message may quote it).
 */
export function callUserOnLink(onLink: (l: TakeoverLink) => unknown, l: TakeoverLink): void {
  const report = (e: unknown) =>
    console.error(`Unstuck: your onLink handler threw (${redactLink(String((e as Error)?.message ?? e), l.url)}); the takeover goes on (session ${l.sessionId})`);
  try {
    const returned = onLink(l);
    if (typeof (returned as PromiseLike<unknown> | undefined)?.then === 'function') (returned as PromiseLike<unknown>).then(undefined, report);
  } catch (e) {
    report(e);
  }
}

/**
 * The params for an ask, or the problem with them as an UnstuckConfigError: checked before any engine is started or asked.
 * (checkAsk covers the ranges; the flags' types are checked here too since JavaScript callers can pass anything.)
 */
export function askParams(question: string, o: AskOptions): AskParams {
  const params: AskParams = {
    question,
    ...(o.choices !== undefined ? { choices: o.choices } : {}),
    ...(o.allowText !== undefined ? { allowText: o.allowText } : {}),
    ...(o.private !== undefined ? { private: o.private } : {}),
    ...(o.details !== undefined ? { details: o.details } : {}),
    ...(o.timeoutS !== undefined ? { timeoutS: o.timeoutS } : {}),
  };
  const { allowText, private: priv } = params as { [k in keyof AskParams]?: unknown };
  const problem =
    checkAsk(params) ??
    (allowText !== undefined && typeof allowText !== 'boolean' ? 'allowText must be true or false' : null) ??
    (priv !== undefined && typeof priv !== 'boolean' ? 'private must be true or false' : null);
  if (problem) throw new UnstuckConfigError(problem);
  return params;
}
