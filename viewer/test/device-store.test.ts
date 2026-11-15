import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { newDeviceKeyPair } from '@velmlabs/unstuck-protocol';
import { indexedDbDeviceStore } from '../src/device-store';

beforeEach(async () => {
  await indexedDbDeviceStore().clear();
});

describe('the device store', () => {
  it('is empty until a device is paired', async () => {
    expect(await indexedDbDeviceStore().get()).toBeNull();
  });

  it('keeps one record per origin, key included, and replaces it on put', async () => {
    const store = indexedDbDeviceStore();
    const a = await newDeviceKeyPair();
    const b = await newDeviceKeyPair();
    await store.put({ deviceId: 'dev1', privateKey: a.privateKey, deviceToken: 'tok1' });
    await store.put({ deviceId: 'dev2', privateKey: b.privateKey, deviceToken: 'tok2' });
    const got = await indexedDbDeviceStore().get();
    expect(got?.deviceId).toBe('dev2');
    expect(got?.deviceToken).toBe('tok2');
    expect(got?.privateKey.type).toBe('private');
  });

  it('clear forgets the device', async () => {
    const store = indexedDbDeviceStore();
    const a = await newDeviceKeyPair();
    await store.put({ deviceId: 'dev1', privateKey: a.privateKey, deviceToken: 't' });
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it('rejects when IndexedDB cannot open', async () => {
    const real = globalThis.indexedDB;
    (globalThis as { indexedDB: unknown }).indexedDB = {
      open: () => {
        const req: { onerror?: () => void; error: Error } = { error: new Error('blocked') };
        queueMicrotask(() => req.onerror?.());
        return req;
      },
    };
    try {
      await expect(indexedDbDeviceStore().get()).rejects.toThrow('blocked');
    } finally {
      (globalThis as { indexedDB: unknown }).indexedDB = real;
    }
  });
});
