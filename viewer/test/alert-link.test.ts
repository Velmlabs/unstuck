import { describe, it, expect } from 'vitest';
import { newDeviceKeyPair, sealAlert, exportDevicePublicKey } from '@velmlabs/unstuck-protocol';
import { openAlertLink } from '../src/alert-link';
import type { DeviceRecord, DeviceStore } from '../src/device-store';

const KEY = 'B'.repeat(43);
const payload = { t: 'TOK', k: KEY, reason: 'Solve the CAPTCHA', site: 'news.example.com', expiresAt: 1_700_000_000_000 };

function memoryStore(rec: DeviceRecord | null): DeviceStore {
  return { get: async () => rec, put: async (r) => void (rec = r), clear: async () => void (rec = null) };
}
async function paired(deviceId = 'dev1') {
  const kp = await newDeviceKeyPair();
  return { pub: await exportDevicePublicKey(kp.publicKey), store: memoryStore({ deviceId, privateKey: kp.privateKey, deviceToken: 'dt' }) };
}

describe('openAlertLink', () => {
  it('turns a sealed #x into #t=…&k=… with reason and site', async () => {
    const { pub, store } = await paired();
    const blob = await sealAlert(pub, 'dev1', 'SESSION', payload);
    const out = await openAlertLink(`#x=dev1.${blob}`, '/v/0.1.5/s/SESSION', store);
    expect(out).toEqual({ hash: `#t=TOK&k=${KEY}`, reason: 'Solve the CAPTCHA', site: 'news.example.com' });
  });

  it('url-encodes the token', async () => {
    const { pub, store } = await paired();
    const blob = await sealAlert(pub, 'dev1', 'SESSION', { ...payload, t: 'a&b=c' });
    const out = await openAlertLink(`#x=dev1.${blob}`, '/s/SESSION', store);
    expect('hash' in out && out.hash).toBe(`#t=a%26b%3Dc&k=${KEY}`);
  });

  it('says no_device with an empty store', async () => {
    const { pub } = await paired();
    const blob = await sealAlert(pub, 'dev1', 'SESSION', payload);
    expect(await openAlertLink(`#x=dev1.${blob}`, '/s/SESSION', memoryStore(null))).toEqual({ error: 'no_device' });
  });

  it('says not_for_this_device for another device id', async () => {
    const { pub, store } = await paired('dev1');
    const blob = await sealAlert(pub, 'dev2', 'SESSION', payload);
    expect(await openAlertLink(`#x=dev2.${blob}`, '/s/SESSION', store)).toEqual({ error: 'not_for_this_device' });
  });

  it('says not_for_this_device for a bad blob, another session, or a malformed fragment', async () => {
    const { pub, store } = await paired();
    const blob = await sealAlert(pub, 'dev1', 'SESSION', payload);
    expect(await openAlertLink('#x=dev1.AAAA', '/s/SESSION', store)).toEqual({ error: 'not_for_this_device' });
    expect(await openAlertLink(`#x=dev1.${blob}`, '/s/OTHER', store)).toEqual({ error: 'not_for_this_device' });
    expect(await openAlertLink(`#x=dev1.${blob}`, '/', store)).toEqual({ error: 'not_for_this_device' });
    expect(await openAlertLink('#x=garbage', '/s/SESSION', store)).toEqual({ error: 'not_for_this_device' });
  });

  it('treats a payload with wrongly typed fields as not for this device', async () => {
    const { pub, store } = await paired();
    const bad: unknown[] = [
      { ...payload, t: 5 },
      { ...payload, k: null },
      { ...payload, reason: {} },
      { ...payload, site: undefined },
      { ...payload, expiresAt: '1' },
      { ...payload, expiresAt: Infinity },
    ];
    for (const p of bad) {
      const blob = await sealAlert(pub, 'dev1', 'SESSION', p as never);
      expect(await openAlertLink(`#x=dev1.${blob}`, '/s/SESSION', store)).toEqual({ error: 'not_for_this_device' });
    }
  });

  it('says no_device when the store cannot be read', async () => {
    const store: DeviceStore = { get: async () => { throw new Error('idb'); }, put: async () => {}, clear: async () => {} };
    expect(await openAlertLink('#x=dev1.AAAA', '/s/SESSION', store)).toEqual({ error: 'no_device' });
  });
});
