import { selectTransport, buildRelayTransport, type Transport } from '@velmlabs/unstuck-core';
import { VERSION } from './version';

export { CLOUD_RELAY_URL, CLOUD_VIEWER_URL, CLOUD_API_URL, selectTransport, viewerUrlFor, cloudAlertsFor, type TransportChoice } from '@velmlabs/unstuck-core';

/** The relay transport for this configuration, or null for embedded mode. Never prints the key. */
export function buildTransport(
  flags: { relay?: string; agentKey?: string },
  env: Record<string, string | undefined>,
  stderr: { write(s: string): unknown },
): { transport: Transport; description: string } | null {
  const choice = selectTransport(flags, env);
  if (choice.kind === 'embedded') return null;
  const transport = buildRelayTransport(choice, { env, version: VERSION, warn: (l) => void stderr.write(l + '\n') });
  return { transport, description: `relay ${choice.url}` };
}
