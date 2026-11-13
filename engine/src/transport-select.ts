import { createRelayTransport, type Transport } from '@unstuck/core';

export const CLOUD_RELAY_URL = 'wss://relay.unstuck.sh';

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

/** The relay transport for this configuration, or null for embedded mode. Never prints the key. */
export function buildTransport(
  flags: { relay?: string; agentKey?: string },
  env: Record<string, string | undefined>,
  stderr: { write(s: string): unknown },
): { transport: Transport; description: string } | null {
  const choice = selectTransport(flags, env);
  if (choice.kind === 'embedded') return null;
  const relay = createRelayTransport({ url: choice.url, agentKey: choice.agentKey });
  const publish = relay.publish.bind(relay);
  relay.publish = (id, opts) =>
    publish(id, opts).catch((e: { detail?: string }) => {
      if (choice.source === 'UNSTUCK_API_KEY' && e.detail === 'relay_unauthorized')
        stderr.write('[unstuck] unstuck.sh rejected UNSTUCK_API_KEY: check the key in your dashboard\n');
      throw e;
    });
  return { transport: relay, description: `relay ${choice.url}` };
}
