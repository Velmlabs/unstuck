// The Durable Object session store from examples/cloudflare-worker, against the same conformance suite as the core stores.
import { describeSessionStore, NOW } from '@velmlabs/unstuck-core/testing/store';
import { durableObjectSessionStore } from '../../examples/cloudflare-worker/src/session-store';

/** The part of DurableObjectStorage the store uses, in memory; transactions run one at a time. */
function fakeStorage() {
  const data = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();
  const storage = {
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => void data.set(key, structuredClone(value)),
    delete: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) data.delete(k);
    },
    list: async <T>(o: { prefix?: string } = {}) => new Map([...data].filter(([k]) => k.startsWith(o.prefix ?? '')) as [string, T][]),
    transaction: <T>(fn: (txn: unknown) => Promise<T>): Promise<T> => {
      const run = chain.then(() => fn(storage));
      chain = run.catch(() => {});
      return run;
    },
  };
  return storage;
}

describeSessionStore('durableObjectSessionStore', async () => durableObjectSessionStore(fakeStorage() as never, { now: () => NOW }));
