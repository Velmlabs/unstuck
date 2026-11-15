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
   * 'required': with Unstuck Cloud, end the takeover at once with status `failed`, detail `alert_failed`, if the link
   * cannot be delivered to at least one paired phone (alerts not allowed for the key, no paired phone, every seal
   * failed, or notify answered non-2xx). Without Unstuck Cloud (a self-hosted relay) it throws UnstuckConfigError.
   */
  alerts?: boolean | 'required';
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
  /** Called when a human is needed. Default: print the link to stderr. */
  onLink?: (link: TakeoverLink) => void;
  /** Relay to use instead of the local server, e.g. wss://relay.example.com (or set UNSTUCK_RELAY_URL). */
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
  /** Override the viewer URL used in takeover links. */
  viewerUrl?: string;
  /** 'binary' runs the engine as a child process (Node); 'in-process' runs it in this JavaScript runtime. */
  mode?: 'binary' | 'in-process';
  /** fetch implementation, for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export function validateOptions(o: UnstuckOptions): void {
  if (o.apiKey && o.relay) throw new UnstuckConfigError('use either apiKey (Unstuck Cloud) or relay + agentKey (your own relay), not both');
  if (o.apiKey && o.agentKey) throw new UnstuckConfigError('agentKey is for your own relay (with relay); Unstuck Cloud only needs apiKey');
  if ((o.cloudRelay || o.cloudApi) && !o.apiKey) throw new UnstuckConfigError('cloudRelay and cloudApi only apply with apiKey');
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
  return env;
}
