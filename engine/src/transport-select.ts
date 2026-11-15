import { createRelayTransport, type Transport } from '@velmlabs/unstuck-core';
import { VERSION } from './version';

export const CLOUD_RELAY_URL = 'wss://relay.unstuck.sh';
/** Unstuck Cloud's viewer, on its own origin; each engine links to the build of its own version. */
export const CLOUD_VIEWER_URL = 'https://view.unstuck.sh/v';

export type TransportChoice =
  | { kind: 'relay'; url: string; agentKey?: string; source: 'flag' | 'UNSTUCK_RELAY_URL' | 'UNSTUCK_API_KEY' }
  | { kind: 'embedded' };

/** Relay spec §5.6: flags → UNSTUCK_RELAY_URL (+ UNSTUCK_AGENT_KEY) → UNSTUCK_API_KEY (Unstuck Cloud) → embedded. */
export function selectTransport(flags: { relay?: string; agentKey?: string }, env: Record<string, string | undefined>): TransportChoice {
  if (flags.relay) return { kind: 'relay', url: flags.relay, agentKey: flags.agentKey ?? env.UNSTUCK_AGENT_KEY, source: 'flag' };
  if (env.UNSTUCK_RELAY_URL) return { kind: 'relay', url: env.UNSTUCK_RELAY_URL, agentKey: env.UNSTUCK_AGENT_KEY, source: 'UNSTUCK_RELAY_URL' };
  if (env.UNSTUCK_API_KEY) return { kind: 'relay', url: env.UNSTUCK_CLOUD_URL ?? CLOUD_RELAY_URL, agentKey: env.UNSTUCK_API_KEY, source: 'UNSTUCK_API_KEY' };
  return { kind: 'embedded' };
}

/**
 * Where links open the viewer: UNSTUCK_VIEWER_URL (https, or http on this machine), else the hosted viewer pinned to this engine's
 * version for the Unstuck Cloud relay, else undefined (the relay's own page, e.g. a self-hosted relay).
 */
export function viewerUrlFor(choice: TransportChoice, env: Record<string, string | undefined>, version: string): string | undefined {
  if (choice.kind !== 'relay') return undefined;
  if (env.UNSTUCK_VIEWER_URL) return /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(env.UNSTUCK_VIEWER_URL) ? env.UNSTUCK_VIEWER_URL : undefined;
  return choice.url.replace(/\/+$/, '') === CLOUD_RELAY_URL ? `${CLOUD_VIEWER_URL}/${version}` : undefined;
}

/** The relay transport for this configuration, or null for embedded mode. Never prints the key. */
export function buildTransport(
  flags: { relay?: string; agentKey?: string },
  env: Record<string, string | undefined>,
  stderr: { write(s: string): unknown },
): { transport: Transport; description: string } | null {
  const choice = selectTransport(flags, env);
  if (choice.kind === 'embedded') return null;
  const viewerUrl = viewerUrlFor(choice, env, VERSION);
  const relay = createRelayTransport({ url: choice.url, agentKey: choice.agentKey, ...(viewerUrl ? { viewerUrl } : {}) });
  const publish = relay.publish.bind(relay);
  relay.publish = (id, opts) =>
    publish(id, opts).catch((e: { detail?: string }) => {
      if (choice.source === 'UNSTUCK_API_KEY' && e.detail === 'relay_unauthorized')
        stderr.write('[unstuck] unstuck.sh rejected UNSTUCK_API_KEY: check the key in your dashboard\n');
      throw e;
    });
  return { transport: relay, description: `relay ${choice.url}` };
}

export const CLOUD_API_URL = 'https://unstuck.sh';

/** Where to send phone alerts: only for Unstuck Cloud via UNSTUCK_API_KEY, not for self-hosted relays or embedded mode. */
export function cloudAlertsFor(choice: TransportChoice, env: Record<string, string | undefined>): { apiBase: string; apiKey: string } | null {
  if (choice.kind !== 'relay' || choice.source !== 'UNSTUCK_API_KEY' || !choice.agentKey) return null;
  return { apiBase: (env.UNSTUCK_CLOUD_API || CLOUD_API_URL).replace(/\/+$/, ''), apiKey: choice.agentKey };
}
