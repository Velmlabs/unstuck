import { describe, it, expect, vi } from 'vitest';
import { newDeviceKeyPair, exportDevicePublicKey, openAlert } from '@velmlabs/unstuck-protocol';
import type { LinkInfo } from '../../src/engine';
import { createCloudAlerter } from '../../src/cloud/alerts';

const T = 'tok_SECRET_value';
const K = 'key_SECRET_value';
const info: LinkInfo = {
  sessionId: 'sess1',
  url: `https://view.unstuck.sh/v/1.2.3/s/sess1?r=wss%3A%2F%2Frelay.unstuck.sh#t=${T}&k=${K}`,
  reason: 'Solve the CAPTCHA',
  expiresAt: 1_700_000_600_000,
};

async function device(id: string) {
  const pair = await newDeviceKeyPair();
  return { id, label: id, publicKey: await exportDevicePublicKey(pair.publicKey), priv: pair.privateKey };
}

function setup(devicesReply: () => Response | Promise<Response>, notifyReply: () => Response | Promise<Response> = () => new Response('', { status: 202 })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const lines: string[] = [];
  let clock = 1_000_000;
  const fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return url.endsWith('/devices') ? devicesReply() : notifyReply();
  }) as unknown as typeof globalThis.fetch;
  const alert = createCloudAlerter({ apiBase: 'https://api.test', apiKey: 'APIKEY', fetch, log: (l) => lines.push(l), now: () => clock });
  return { alert, calls, lines, tick: (ms: number) => (clock += ms) };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

describe('createCloudAlerter', () => {
  it('seals {t,k,reason,site,expiresAt} per device and posts the link without its fragment', async () => {
    const a = await device('d1');
    const b = await device('d2');
    const s = setup(() => json({ devices: [a, b].map(({ id, publicKey, label }) => ({ id, publicKey, label })) }));
    await s.alert(info, 'news.example.com');
    expect(s.calls.map((c) => c.url)).toEqual(['https://api.test/api/v1/agent/devices', 'https://api.test/api/v1/agent/notify']);
    for (const c of s.calls) expect((c.init.headers as Record<string, string>).Authorization).toBe('Bearer APIKEY');
    const body = JSON.parse(s.calls[1]!.init.body as string);
    expect(body.sessionId).toBe('sess1');
    expect(body.viewerUrl).toBe('https://view.unstuck.sh/v/1.2.3/s/sess1?r=wss%3A%2F%2Frelay.unstuck.sh');
    expect(body.sealed.map((x: { device: string }) => x.device)).toEqual(['d1', 'd2']);
    for (const [i, d] of [a, b].entries()) {
      const opened = await openAlert(d.priv, d.id, 'sess1', body.sealed[i].blob);
      expect(opened).toEqual({ t: T, k: K, reason: 'Solve the CAPTCHA', site: 'news.example.com', expiresAt: info.expiresAt });
    }
    const raw = s.calls[1]!.init.body as string;
    expect(raw).not.toContain(T);
    expect(raw).not.toContain(K);
    expect(raw).not.toContain('#');
  });

  it('uses an empty site when the takeover has none', async () => {
    const a = await device('d1');
    const s = setup(() => json({ devices: [a] }));
    await s.alert(info, undefined);
    const body = JSON.parse(s.calls[1]!.init.body as string);
    expect((await openAlert(a.priv, 'd1', 'sess1', body.sealed[0].blob))!.site).toBe('');
  });

  it('caches the device list for 60 s', async () => {
    const a = await device('d1');
    const s = setup(() => json({ devices: [a] }));
    await s.alert(info, 'x.com');
    s.tick(59_000);
    await s.alert(info, 'x.com');
    expect(s.calls.filter((c) => c.url.endsWith('/devices'))).toHaveLength(1);
    expect(s.calls.filter((c) => c.url.endsWith('/notify'))).toHaveLength(2);
    s.tick(2_000);
    await s.alert(info, 'x.com');
    expect(s.calls.filter((c) => c.url.endsWith('/devices'))).toHaveLength(2);
  });

  it('403 alerts_not_allowed: one log line, no notify call', async () => {
    const s = setup(() => json({ error: 'alerts_not_allowed' }, 403));
    await s.alert(info, 'x.com');
    expect(s.calls).toHaveLength(1);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatch(/^\[unstuck\] .*alerts/);
  });

  it('no devices: no notify call, nothing logged', async () => {
    const s = setup(() => json({ devices: [] }));
    await s.alert(info, 'x.com');
    expect(s.calls).toHaveLength(1);
    expect(s.lines).toEqual([]);
  });

  it('a link without a fragment does nothing', async () => {
    const s = setup(() => json({ devices: [] }));
    await s.alert({ ...info, url: 'http://127.0.0.1:1/s/sess1' }, 'x.com');
    await s.alert({ ...info, url: 'not a url' }, 'x.com');
    await s.alert({ ...info, url: 'http://127.0.0.1:1/s/sess1#t=only' }, 'x.com');
    expect(s.calls).toHaveLength(0);
  });

  it('fetch throwing, 5xx, bad json or a bad device key resolve with one log line and no secrets', async () => {
    const throwing = setup(() => Promise.reject(new Error('boom APIKEY')));
    await expect(throwing.alert(info, 'x.com')).resolves.toBeUndefined();
    expect(throwing.lines).toHaveLength(1);

    const five = setup(() => new Response('', { status: 503 }));
    await five.alert(info, 'x.com');
    expect(five.lines).toHaveLength(1);

    const a = await device('d1');
    const badNotify = setup(() => json({ devices: [a] }), () => new Response('', { status: 500 }));
    await badNotify.alert(info, 'x.com');
    expect(badNotify.lines).toHaveLength(2); // sealed-to line, then the failure
    expect(badNotify.lines[1]).toMatch(/could not send/);

    const badJson = setup(() => new Response('<html>', { status: 200 }));
    await badJson.alert(info, 'x.com');
    expect(badJson.lines).toHaveLength(1);

    const badKey = setup(() => json({ devices: [{ id: 'd', publicKey: 'AAAA', label: 'x' }] }));
    await badKey.alert(info, 'x.com');
    expect(badKey.lines).toHaveLength(1);
    expect(badKey.calls).toHaveLength(1); // nothing sealed: no notify call

    for (const s of [throwing, five, badNotify, badJson, badKey]) for (const l of s.lines) for (const secret of [T, K, 'APIKEY']) expect(l).not.toContain(secret);
  });

  it('a thrown non-Error still resolves with one log line', async () => {
    for (const thrown of ['just a string', undefined, null, 42]) {
      const s = setup(() => Promise.reject(thrown));
      await expect(s.alert(info, 'x.com')).resolves.toBeUndefined();
      expect(s.lines).toHaveLength(1);
    }
    const masked = setup(() => Promise.reject('failed for APIKEY'));
    await masked.alert(info, 'x.com');
    expect(masked.lines[0]).not.toContain('APIKEY');
  });

  it('only 403 alerts_not_allowed is "not enabled" and cached; any other 403 is a failure and is not cached', async () => {
    const other = setup(() => json({ error: 'suspended' }, 403));
    await other.alert(info, 'x.com');
    await other.alert(info, 'x.com');
    expect(other.calls).toHaveLength(2); // not cached: asked again
    expect(other.lines).toHaveLength(2);
    expect(other.lines[0]).not.toMatch(/not enabled/);
    const noBody = setup(() => new Response('', { status: 403 }));
    await noBody.alert(info, 'x.com');
    expect(noBody.lines[0]).not.toMatch(/not enabled/);

    const denied = setup(() => json({ error: 'alerts_not_allowed' }, 403));
    await denied.alert(info, 'x.com');
    await denied.alert(info, 'x.com');
    expect(denied.calls).toHaveLength(1); // cached
    expect(denied.lines).toHaveLength(1);
    expect(denied.lines[0]).toMatch(/not enabled/);
  });

  it('logs which phones it sealed to, first time and whenever the set changes, never the key, token or link', async () => {
    const a = await device('d1');
    const b = await device('d2');
    let list = [a];
    const s = setup(() => json({ devices: list.map(({ id, publicKey }) => ({ id, publicKey, label: id === 'd1' ? 'iPhone \u202eevil\u0007' : 'Pixel' })) }));
    await s.alert(info, 'x.com');
    expect(s.lines).toEqual(['[unstuck] alert sealed to 1 phone(s): iPhone evil (d1)']);
    s.tick(61_000);
    await s.alert(info, 'x.com');
    expect(s.lines).toHaveLength(1); // same set: no new line
    list = [a, b];
    s.tick(61_000);
    await s.alert(info, 'x.com');
    expect(s.lines).toEqual(['[unstuck] alert sealed to 1 phone(s): iPhone evil (d1)', '[unstuck] alert sealed to 2 phone(s): iPhone evil (d1), Pixel (d2)']);
    for (const l of s.lines) for (const secret of [T, K, 'APIKEY', 'view.unstuck.sh']) expect(l).not.toContain(secret);
  });

  it('a device with a bad key is skipped (one line); the others still get the alert', async () => {
    const a = await device('d1');
    const s = setup(() => json({ devices: [{ id: 'bad', publicKey: 'AAAA', label: 'Old phone' }, { id: a.id, publicKey: a.publicKey, label: 'Pixel' }] }));
    await s.alert(info, 'x.com');
    const body = JSON.parse(s.calls[1]!.init.body as string);
    expect(body.sealed.map((x: { device: string }) => x.device)).toEqual(['d1']);
    expect(s.lines).toEqual(['[unstuck] skipped phone Old phone (bad): its key is not valid', '[unstuck] alert sealed to 1 phone(s): Pixel (d1)']);
  });

  it('caps the sealed reason at 200 and the site at 253 code points', async () => {
    const a = await device('d1');
    const s = setup(() => json({ devices: [a] }));
    await s.alert({ ...info, reason: '\u{1F600}'.repeat(5000) }, 'a'.repeat(300));
    const body = JSON.parse(s.calls[1]!.init.body as string);
    const p = (await openAlert(a.priv, 'd1', 'sess1', body.sealed[0].blob))!;
    expect([...p.reason]).toHaveLength(200);
    expect(p.reason).toBe('\u{1F600}'.repeat(200));
    expect(p.site).toBe('a'.repeat(253));
    expect(body.sealed[0].blob.length).toBeLessThan(2000);
  });

  it('defaults: global fetch, console-free stderr log and Date.now; a trailing slash on the base is stripped', async () => {
    const orig = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (u: string) => (urls.push(u), json({ error: 'alerts_not_allowed' }, 403))) as unknown as typeof fetch;
    const written: string[] = [];
    const write = vi.spyOn(console, 'error').mockImplementation((c: unknown) => void written.push(String(c)));
    try {
      await createCloudAlerter({ apiBase: 'https://api.test//', apiKey: 'k' })(info, 'x.com');
    } finally {
      globalThis.fetch = orig;
      write.mockRestore();
    }
    expect(urls).toEqual(['https://api.test/api/v1/agent/devices']);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^\[unstuck\] /);
  });
});
