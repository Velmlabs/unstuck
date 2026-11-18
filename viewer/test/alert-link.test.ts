import { describe, it, expect, vi, afterEach } from 'vitest';
import { newDeviceKeyPair, sealAlert, exportDevicePublicKey } from '@velmlabs/unstuck-protocol';
import { apiBaseForAlerts, checkSender, cleanLabel, openAlertLink, openAlertLinkSafely } from '../src/alert-link';
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
    expect(out).toMatchObject({ hash: `#t=TOK&k=${KEY}`, reason: 'Solve the CAPTCHA', site: 'news.example.com', deviceToken: 'dt' });
  });

  it('a sealed question or approval says so (mode, question) and keeps the hint in the fragment for a reload', async () => {
    const { pub, store } = await paired();
    const q = await sealAlert(pub, 'dev1', 'SESSION', { ...payload, site: '', reason: 'Window or aisle?', mode: 'question', question: 'Window or aisle?' });
    expect(await openAlertLink(`#x=dev1.${q}`, '/s/SESSION', store)).toMatchObject({ hash: `#t=TOK&k=${KEY}&m=q`, mode: 'question', question: 'Window or aisle?' });
    const a = await sealAlert(pub, 'dev1', 'SESSION', { ...payload, mode: 'approval' });
    const out = await openAlertLink(`#x=dev1.${a}`, '/s/SESSION', store);
    expect(out).toMatchObject({ hash: `#t=TOK&k=${KEY}&m=a`, mode: 'approval' });
    expect(out).not.toHaveProperty('question');
    // control, an unknown mode or a question that isn't text: today's link
    for (const extra of [{ mode: 'control' }, { mode: 'nope' }, { question: 7 }]) {
      const b = await sealAlert(pub, 'dev1', 'SESSION', { ...payload, ...extra } as never);
      const o = await openAlertLink(`#x=dev1.${b}`, '/s/SESSION', store);
      expect(o).toMatchObject({ hash: `#t=TOK&k=${KEY}` });
      expect(o).not.toHaveProperty('mode');
      expect(o).not.toHaveProperty('question');
    }
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
    // Without a paired phone, any sealed link is "no device" (not_for_this_device means this browser IS paired).
    expect(await openAlertLink('#x=garbage', '/s/SESSION', memoryStore(null))).toEqual({ error: 'no_device' });
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

describe('openAlertLinkSafely', () => {
  afterEach(() => vi.useRealTimers());

  it('passes a result through', async () => {
    const { pub, store } = await paired();
    const blob = await sealAlert(pub, 'dev1', 'SESSION', payload);
    expect(await openAlertLinkSafely(`#x=dev1.${blob}`, '/s/SESSION', store)).toMatchObject({ reason: 'Solve the CAPTCHA' });
  });

  it('a store that never answers is no_device after 5 s', async () => {
    vi.useFakeTimers();
    const store: DeviceStore = { get: () => new Promise(() => {}), put: async () => {}, clear: async () => {} };
    const out = openAlertLinkSafely('#x=dev1.AAAA', '/s/SESSION', store);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await out).toEqual({ error: 'no_device' });
  });

  it('anything that throws is no_device', async () => {
    const store = { get: () => { throw new Error('sync'); } } as unknown as DeviceStore;
    expect(await openAlertLinkSafely('#x=dev1.AAAA', '/s/SESSION', store)).toEqual({ error: 'no_device' });
  });
});

describe('apiBaseForAlerts', () => {
  const rec = (apiBase?: string) => ({ deviceId: 'd', privateKey: {} as CryptoKey, deviceToken: 't', ...(apiBase ? { apiBase } : {}) });
  it('is always Unstuck Cloud on view.unstuck.sh', () => {
    expect(apiBaseForAlerts('view.unstuck.sh', rec('https://evil.example'))).toBe('https://unstuck.sh');
  });
  it('elsewhere is the API base stored at pairing, or Unstuck Cloud for old records and bad values', () => {
    expect(apiBaseForAlerts('view.staging.example', rec('https://api.staging.example'))).toBe('https://api.staging.example');
    expect(apiBaseForAlerts('localhost', rec('http://127.0.0.1:8787'))).toBe('http://127.0.0.1:8787');
    expect(apiBaseForAlerts('view.staging.example', rec())).toBe('https://unstuck.sh');
    expect(apiBaseForAlerts('view.staging.example', rec('http://evil.example'))).toBe('https://unstuck.sh');
    expect(apiBaseForAlerts('view.staging.example', rec('not a url'))).toBe('https://unstuck.sh');
  });
});

describe('checkSender', () => {
  const call = (res: () => Promise<Response>) => {
    const fetchFn = vi.fn((_u: string, _i?: RequestInit) => res());
    return { fetchFn, out: checkSender({ apiBase: 'https://api.test', deviceToken: 'DT', sessionId: 'S1', fetchFn: fetchFn as unknown as typeof fetch }) };
  };
  it('asks Cloud with the device token and returns the key name on 200', async () => {
    const { fetchFn, out } = call(async () => new Response(JSON.stringify({ keyName: 'crawler-prod' }), { status: 200 }));
    expect(await out).toEqual({ keyName: 'crawler-prod' });
    expect(fetchFn.mock.calls[0]![0]).toBe('https://api.test/api/v1/devices/self/alerts/S1');
    expect((fetchFn.mock.calls[0]![1] as RequestInit).headers).toEqual({ Authorization: 'Bearer DT' });
  });
  it('404 is not_sent; other answers, bad bodies and network errors are null', async () => {
    expect(await call(async () => new Response('{}', { status: 404 })).out).toBe('not_sent');
    expect(await call(async () => new Response('{}', { status: 401 })).out).toBeNull();
    expect(await call(async () => new Response('{}', { status: 500 })).out).toBeNull();
    expect(await call(async () => new Response('<html>', { status: 200 })).out).toBeNull();
    expect(await call(async () => new Response(JSON.stringify({ keyName: 5 }), { status: 200 })).out).toBeNull();
    expect(await call(async () => Promise.reject(new Error('offline'))).out).toBeNull();
  });
  it('encodes the session id', async () => {
    const { fetchFn, out } = call(async () => new Response('{}', { status: 404 }));
    await out;
    expect(String(fetchFn.mock.calls[0]![0])).toBe('https://api.test/api/v1/devices/self/alerts/S1');
    const f2 = vi.fn(async (_u: string) => new Response('{}', { status: 404 }));
    await checkSender({ apiBase: 'https://api.test', deviceToken: 'DT', sessionId: 'a/b', fetchFn: f2 as unknown as typeof fetch });
    expect(String(f2.mock.calls[0]![0])).toBe('https://api.test/api/v1/devices/self/alerts/a%2Fb');
  });
});

describe('cleanLabel', () => {
  it('drops control, bidi and zero-width characters and cuts to 64 code points', () => {
    expect(cleanLabel('a\u202eb\u200bc\u0007d\u2066e')).toBe('abcde');
    expect(cleanLabel('\u{1F600}'.repeat(70))).toBe('\u{1F600}'.repeat(64));
    expect(cleanLabel('  x  ')).toBe('x');
  });
});
