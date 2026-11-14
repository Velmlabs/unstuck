import type { RelayEvent } from '@velmlabs/unstuck-relay-core';
import { createRelayWorker } from '../../src/worker';

/** Test-only hooks: the events the relay reports, a controllable clock, and an override for authorize. */
export const probe = {
  events: [] as RelayEvent[],
  offset: 0,
  refuse: null as null | 402,
};

const relay = createRelayWorker({
  now: () => Date.now() + probe.offset,
  // Some hosts' hooks are async (e.g. writing usage to D1): exercise both shapes.
  onEvent: (e) => (probe.events.push(e), e.name === 'session_closed' ? Promise.resolve() : undefined),
  authorize: async (key, _ctx, env) => {
    if (probe.refuse) return { ok: false, status: probe.refuse, error: 'quota' };
    const keys = (env.AGENT_KEYS ?? '').split(',');
    return key && keys.includes(key) ? { ok: true, account: `acct:${key}` } : { ok: false, status: 401, error: 'unauthorized' };
  },
});

export default { fetch: relay.fetch };
export const RelaySessionDO = relay.RelaySessionDO;
