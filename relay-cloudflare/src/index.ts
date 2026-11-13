// Default self-hosted entry: agent keys from the AGENT_KEYS secret (or RELAY_OPEN=1 for local testing).
import { createRelayWorker } from './worker';

const relay = createRelayWorker({ onEvent: (e) => console.log(JSON.stringify(e)) });

export default { fetch: relay.fetch } satisfies ExportedHandler<import('./worker').RelayEnv>;
export const RelaySessionDO = relay.RelaySessionDO;
export { createRelayWorker, type RelayEnv, type RelayWorkerOptions } from './worker';
