import { describe, it, expect, vi, afterEach } from 'vitest';
import { newDeviceKeyPair, exportDevicePublicKey, openAlert } from '@velmlabs/unstuck-protocol';
import type { LinkInfo } from '../../src/engine';
import { ALERT_TIMEOUT_MS, cleanAgentName, createCloudAlerter, sendTakeoverAlert, type CloudAlerter } from '../../src/cloud/alerts';
import { settle } from '../settle';

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

function setup(
  devicesReply: () => Response | Promise<Response>,
  notifyReply: () => Response | Promise<Response> = () => new Response('', { status: 202 }),
  agentName?: string,
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const lines: string[] = [];
  let clock = 1_000_000;
  const fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return url.endsWith('/devices') ? devicesReply() : notifyReply();
  }) as unknown as typeof globalThis.fetch;
  const alert = createCloudAlerter({ apiBase: 'https://api.test', apiKey: 'APIKEY', fetch, log: (l) => lines.push(l), now: () => clock, ...(agentName ? { agentName } : {}) });
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
    await expect(throwing.alert(info, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'error' });
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
      await expect(s.alert(info, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'error' });
      expect(s.lines).toHaveLength(1);
    }
    const masked = setup(() => Promise.reject('failed for APIKEY'));
    await masked.alert(info, 'x.com');
    expect(masked.lines[0]).not.toContain('APIKEY');
  });

  it('only 403 alerts_not_allowed is "not enabled"; neither it nor any other failure is cached', async () => {
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
    expect(denied.calls).toHaveLength(2); // not cached: alerts may have been turned on since
    expect(denied.lines).toHaveLength(2);
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

  describe('the outcome it resolves with (for alerts: required)', () => {
    it('delivered: how many phones the link was sealed to, once Cloud accepted it', async () => {
      const a = await device('d1');
      const b = await device('d2');
      const s = setup(() => json({ devices: [a, b, { id: 'bad', publicKey: 'AAAA' }] }));
      await expect(s.alert(info, 'x.com')).resolves.toEqual({ delivered: 2 });
    });
    it('alerts not allowed for the key, asked again each time (turning alerts on takes effect at once)', async () => {
      let allowed = false;
      const a = await device('d1');
      const s = setup(() => (allowed ? json({ devices: [a] }) : json({ error: 'alerts_not_allowed' }, 403)));
      await expect(s.alert(info, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'alerts_not_allowed' });
      await expect(s.alert(info, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'alerts_not_allowed' });
      expect(s.calls).toHaveLength(2);
      allowed = true;
      await expect(s.alert(info, 'x.com')).resolves.toEqual({ delivered: 1 });
    });
    it('no paired phone', async () => {
      const s = setup(() => json({ devices: [] }));
      await expect(s.alert(info, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'no_devices' });
    });
    it('every seal failed', async () => {
      const s = setup(() => json({ devices: [{ id: 'd', publicKey: 'AAAA' }] }));
      await expect(s.alert(info, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'seal_failed' });
    });
    it('notify answered non-2xx', async () => {
      const a = await device('d1');
      const s = setup(() => json({ devices: [a] }), () => new Response('', { status: 500 }));
      await expect(s.alert(info, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'notify_failed' });
      expect(s.lines[1]).toMatch(/could not send the phone alert: notify answered 500/);
    });
    it('a 401 from either call: the key was rejected', async () => {
      const devices = setup(() => new Response('', { status: 401 }));
      await expect(devices.alert(info, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'unauthorized' });
      expect(devices.lines).toEqual(['[unstuck] could not send the phone alert: devices lookup answered 401']);
      const a = await device('d1');
      const notify = setup(() => json({ devices: [a] }), () => new Response('', { status: 401 }));
      await expect(notify.alert(info, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'unauthorized' });
    });
    it('anything else (5xx lookup, bad json, a link without a fragment) is an error', async () => {
      await expect(setup(() => new Response('', { status: 503 })).alert(info, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'error' });
      await expect(setup(() => new Response('<html>')).alert(info, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'error' });
      await expect(setup(() => json({ devices: [] })).alert({ ...info, url: 'http://127.0.0.1:1/s/sess1' }, 'x.com')).resolves.toEqual({ delivered: 0, problem: 'error' });
    });
  });

  describe('a Cloud call that never answers gives up after 10 s (error), so required fails promptly', () => {
    afterEach(() => vi.useRealTimers());
    const hang = (seen: (AbortSignal | undefined)[]) => (_url: string, init: RequestInit = {}) => {
      seen.push(init.signal ?? undefined);
      return new Promise<Response>(() => {}); // ignores the signal too
    };
    it('the devices lookup', async () => {
      vi.useFakeTimers();
      const signals: (AbortSignal | undefined)[] = [];
      const lines: string[] = [];
      const alert = createCloudAlerter({ apiBase: 'https://api.test', apiKey: 'APIKEY', fetch: hang(signals) as never, log: (l) => lines.push(l) });
      const out = alert(info, 'x.com');
      await vi.advanceTimersByTimeAsync(ALERT_TIMEOUT_MS - 1);
      expect(signals[0]!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(out).resolves.toEqual({ delivered: 0, problem: 'error' });
      expect(signals[0]!.aborted).toBe(true);
      expect(lines).toEqual(['[unstuck] could not send the phone alert: devices lookup took longer than 10 s']);
      expect(vi.getTimerCount()).toBe(0);
    });
    it('the notify call', async () => {
      const a = await device('d1');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const signals: (AbortSignal | undefined)[] = [];
      const fetch = (url: string, init?: RequestInit) => (url.endsWith('/devices') ? Promise.resolve(json({ devices: [a] })) : hang(signals)(url, init));
      const lines: string[] = [];
      const alert = createCloudAlerter({ apiBase: 'https://api.test', apiKey: 'APIKEY', fetch: fetch as never, log: (l) => lines.push(l) });
      const out = alert(info, 'x.com');
      while (signals.length === 0) await new Promise((r) => setImmediate(r)); // sealing runs on real crypto
      await vi.advanceTimersByTimeAsync(ALERT_TIMEOUT_MS);
      await expect(out).resolves.toEqual({ delivered: 0, problem: 'error' });
      expect(signals[0]!.aborted).toBe(true);
      expect(lines.at(-1)).toBe('[unstuck] could not send the phone alert: notify took longer than 10 s');
    });
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

describe('sendTakeoverAlert', () => {
  const ok = async () => ({ delivered: 1 });
  const none = async () => ({ delivered: 0 as const, problem: 'no_devices' as const });
  const rejects = () => Promise.reject(new Error('custom alerter broke'));
  const throws = () => {
    throw new Error('custom alerter threw');
  };
  /** Runs it and waits until the alert (if any) has been looked at. */
  const run = async (alerter: Parameters<typeof sendTakeoverAlert>[0], alerts: boolean | 'required' | undefined, joined = false) => {
    const fail = vi.fn();
    const spy = alerter && vi.fn(alerter);
    let looked = false;
    const outcome = sendTakeoverAlert(spy, alerts, info, 'x.com', {
      fail,
      cancel: vi.fn(),
      ended: new Promise(() => {}),
      joined: () => {
        looked = true;
        return joined;
      },
    });
    await settle();
    return { sent: spy ? spy.mock.calls.length : 0, fail: fail.mock.calls, looked, outcome: outcome && (await outcome) };
  };

  it("alerts false or no alerter: nothing sent; true: sent, never fails; 'required': fails only when no phone got it", async () => {
    expect(await run(none, false)).toMatchObject({ sent: 0, fail: [] });
    expect(await run(null, 'required')).toMatchObject({ sent: 0, fail: [] });
    expect(await run(none, undefined)).toMatchObject({ sent: 1, fail: [] });
    expect(await run(none, true)).toMatchObject({ sent: 1, fail: [] });
    expect(await run(ok, 'required')).toMatchObject({ sent: 1, fail: [] });
    expect(await run(none, 'required')).toEqual({ sent: 1, fail: [['alert_failed']], looked: true, outcome: { delivered: 0, problem: 'no_devices' } });
  });

  it('returns the outcome (null when nothing is sent), so a link handler can wait for it', async () => {
    expect(await run(none, false)).toMatchObject({ outcome: null });
    expect(await run(null, true)).toMatchObject({ outcome: null });
    expect(await run(ok, true)).toMatchObject({ outcome: { delivered: 1 } });
    expect(await run(rejects, true)).toMatchObject({ outcome: { delivered: 0, problem: 'error' } });
    expect(await run(throws, true)).toMatchObject({ outcome: { delivered: 0, problem: 'error' } });
  });

  it("a custom alerter that rejects or throws counts as no phone reached, with no unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(await run(rejects, 'required')).toMatchObject({ sent: 1, fail: [['alert_failed']] });
      expect(await run(throws, 'required')).toMatchObject({ sent: 1, fail: [['alert_failed']] });
      expect(await run(rejects, true)).toMatchObject({ sent: 1, fail: [] });
      expect(await run(throws, undefined)).toMatchObject({ sent: 1, fail: [] });
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it("'required' never fails a takeover someone already joined through the link", async () => {
    expect(await run(none, 'required', true)).toEqual({ sent: 1, fail: [], looked: true, outcome: { delivered: 0, problem: 'no_devices' } });
  });
});


describe('cleanAgentName', () => {
  it('removes control, zero-width and bidi characters, trims and caps at 40 code points', () => {
    expect(cleanAgentName('‮A'.padEnd(60, 'b'))).toHaveLength(40);
    expect(cleanAgentName('  Travel​\u0007 bot\n ')).toBe('Travel bot');
    expect(cleanAgentName('⁦x⁩﻿⁠')).toBe('x');
    expect(cleanAgentName('😀'.repeat(50))).toBe('😀'.repeat(40));
  });
  it('is undefined when nothing is left (or not a string)', () => {
    expect(cleanAgentName(undefined)).toBeUndefined();
    expect(cleanAgentName('')).toBeUndefined();
    expect(cleanAgentName(' ​‮\n')).toBeUndefined();
    expect(cleanAgentName(7 as never)).toBeUndefined();
  });
});

describe('alert privacy and content', () => {
  const body = async (i: LinkInfo, site: string | undefined, extra?: Parameters<CloudAlerter>[2], agentName?: string) => {
    const a = await device('d1');
    const s = setup(() => json({ devices: [a] }), undefined, agentName);
    await s.alert(i, site, extra);
    const raw = s.calls[1]!.init.body as string;
    return { raw, body: JSON.parse(raw), a, sealed: JSON.parse(raw).sealed[0].blob as string };
  };
  const approval: LinkInfo = { ...info, reason: 'Please approve a sign-in on your phone', kind: 'approval', mode: 'approval' };
  const question: LinkInfo = { ...info, reason: 'Should I wire $4,200 to Acme Corp?', kind: 'question', mode: 'question' };

  it('notify body carries kind, agentName and expiresAt, never reason or site', async () => {
    const r = await body(approval, 'accounts.example.com', undefined, 'Travel bot');
    expect(r.body).toMatchObject({ kind: 'approval', agentName: 'Travel bot', expiresAt: info.expiresAt });
    expect(r.raw).not.toMatch(/accounts\.example|approve a sign-in/);
    expect(r.body).not.toHaveProperty('question');
    expect(r.body).not.toHaveProperty('choices');
  });

  it("kind defaults to 'other'; no agentName key when none is set; a dirty name is cleaned", async () => {
    const r = await body(info, 'x.com');
    expect(r.body.kind).toBe('other');
    expect(r.body).not.toHaveProperty('agentName');
    const r2 = await body(info, 'x.com', undefined, '‮Bot​');
    expect(r2.body.agentName).toBe('Bot');
  });

  it('a private question: the question text is in the sealed payload only, never in the readable body', async () => {
    const r = await body(question, undefined, undefined, 'Pay bot');
    expect(r.body).toMatchObject({ kind: 'question', agentName: 'Pay bot' });
    expect(r.raw).not.toContain('wire');
    expect(r.raw).not.toContain('Acme');
    expect(r.body).not.toHaveProperty('question');
    expect(r.body).not.toHaveProperty('choices');
    expect(await openAlert(r.a.priv, 'd1', 'sess1', r.sealed)).toMatchObject({ mode: 'question', question: 'Should I wire $4,200 to Acme Corp?', t: T, k: K });
  });

  it('a takeover: the sealed payload carries mode and no question; the body has no reason or site', async () => {
    const r = await body(approval, 'accounts.example.com');
    const opened = await openAlert(r.a.priv, 'd1', 'sess1', r.sealed);
    expect(opened).toMatchObject({ mode: 'approval', reason: 'Please approve a sign-in on your phone', site: 'accounts.example.com' });
    expect(opened).not.toHaveProperty('question');
  });

  it('a quick question adds question and choices to the readable body', async () => {
    const quick = { question: 'Ship it?', choices: ['Yes', 'No'] };
    const r = await body({ ...question, reason: 'Ship it?' }, undefined, { quick });
    expect(r.body).toMatchObject({ kind: 'question', question: 'Ship it?', choices: ['Yes', 'No'] });
    expect(await openAlert(r.a.priv, 'd1', 'sess1', r.sealed)).toMatchObject({ mode: 'question', question: 'Ship it?' });
  });
});

describe('end report', () => {
  const endCall = (s: ReturnType<typeof setup>) => s.calls.filter((c) => c.url.endsWith('/alerts/end'));

  it('posts status, duration and label (and byAgent) to /api/v1/alerts/end with the key', async () => {
    const s = setup(() => json({ devices: [] }));
    await s.alert.end!({ sessionId: 'sess1', status: 'answered', durationS: 12.5, label: 'Yes' });
    await s.alert.end!({ sessionId: 'sess2', status: 'cancelled', durationS: 3, byAgent: true });
    const [c1, c2] = endCall(s);
    expect(c1!.url).toBe('https://api.test/api/v1/alerts/end');
    expect(c1!.init.method).toBe('POST');
    expect((c1!.init.headers as Record<string, string>).Authorization).toBe('Bearer APIKEY');
    expect(JSON.parse(c1!.init.body as string)).toEqual({ sessionId: 'sess1', status: 'answered', durationS: 12.5, label: 'Yes' });
    expect(JSON.parse(c2!.init.body as string)).toEqual({ sessionId: 'sess2', status: 'cancelled', durationS: 3, byAgent: true });
  });

  it('a failure is logged once and never throws', async () => {
    const s = setup(() => json({ devices: [] }), () => new Response('', { status: 500 }));
    await expect(s.alert.end!({ sessionId: 'sess1', status: 'resolved', durationS: 1 })).resolves.toBeUndefined();
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatch(/^\[unstuck\] /);
    expect(s.lines[0]).not.toContain('APIKEY');
    const lines: string[] = [];
    const boom = createCloudAlerter({ apiBase: 'https://api.test', apiKey: 'APIKEY', fetch: (async () => { throw new Error('net down APIKEY'); }) as unknown as typeof fetch, log: (l) => lines.push(l) });
    await expect(boom.end!({ sessionId: 's', status: 'failed', durationS: 0 })).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('APIKEY');
  });

  it('gives up after ALERT_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const hang = createCloudAlerter({ apiBase: 'https://api.test', apiKey: 'k', fetch: (() => new Promise(() => {})) as unknown as typeof fetch, log: (l) => lines.push(l) });
      const p = hang.end!({ sessionId: 's', status: 'timed_out', durationS: 1 });
      await vi.advanceTimersByTimeAsync(ALERT_TIMEOUT_MS + 1);
      await p;
      expect(lines).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('from sendTakeoverAlert', () => {
    type R = import('@velmlabs/unstuck-protocol').TakeoverResult;
    const result = (r: Partial<R> = {}): R => ({ status: 'resolved', sessionId: 'sess1', url: '', durationS: 8, ...r });
    const run = async (r: R, o: { delivered?: number; quick?: { question: string; choices: string[] }; noEnd?: boolean; alerts?: boolean | 'required' } = {}) => {
      const end = vi.fn(async () => {});
      const alerter = Object.assign(async () => ({ delivered: o.delivered ?? 1 }), o.noEnd ? {} : { end }) as CloudAlerter;
      let finish!: (r: R) => void;
      const ended = new Promise<R>((res) => (finish = res));
      const fail = vi.fn();
      void sendTakeoverAlert(alerter, o.alerts ?? true, info, 'x.com', { fail, cancel: vi.fn(), ended, joined: () => false }, o.quick);
      await settle();
      const before = end.mock.calls.length;
      finish(r);
      await settle();
      return { end: (end.mock.calls as unknown[][]).map((c) => c[0]), before, fail };
    };

    it('reports after the takeover ends, only when an alert was delivered', async () => {
      const a = await run(result({ durationS: 8 }));
      expect(a.before).toBe(0);
      expect(a.end).toEqual([{ sessionId: 'sess1', status: 'resolved', durationS: 8 }]);
      expect((await run(result(), { delivered: 0 })).end).toEqual([]);
    });

    it('works with an alerter that has no end (a plain function), and swallows one that throws or rejects', async () => {
      expect((await run(result(), { noEnd: true })).end).toEqual([]);
      for (const bad of [() => Promise.reject(new Error('x')), () => { throw new Error('y'); }]) {
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        const alerter = Object.assign(async () => ({ delivered: 1 }), { end: bad }) as unknown as CloudAlerter;
        sendTakeoverAlert(alerter, true, info, 'x.com', { fail: vi.fn(), cancel: vi.fn(), ended: Promise.resolve(result()), joined: () => false });
        await settle();
        await new Promise((r) => setTimeout(r, 0));
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
      }
    });

    it('byAgent only for cancelled_by_agent and engine_closed; the detail text never goes', async () => {
      const a = await run(result({ status: 'cancelled', detail: 'cancelled_by_agent' }));
      const b = await run(result({ status: 'cancelled', detail: 'engine_closed' }));
      const c = await run(result({ status: 'failed', detail: 'viewer_left' }));
      const d = await run(result({ status: 'failed', detail: 'alert_failed' }));
      expect(a.end).toEqual([{ sessionId: 'sess1', status: 'cancelled', durationS: 8, byAgent: true }]);
      expect(b.end).toEqual([{ sessionId: 'sess1', status: 'cancelled', durationS: 8, byAgent: true }]);
      expect(c.end).toEqual([{ sessionId: 'sess1', status: 'failed', durationS: 8 }]);
      expect(JSON.stringify([a, b, c, d].map((x) => x.end))).not.toMatch(/viewer_left|cancelled_by_agent|engine_closed|alert_failed/);
    });

    const quick = { question: 'Ship it?', choices: ['Yes', 'No'] };
    const answered = (answer: R['answer'], via: R['via'] = 'telegram') => result({ status: 'answered', answer, via });

    it('label only for a quick question answered with a choice label', async () => {
      expect((await run(answered({ choice: 0, label: 'Yes' }), { quick })).end).toEqual([{ sessionId: 'sess1', status: 'answered', durationS: 8, label: 'Yes' }]);
      expect((await run(answered({ choice: 1, label: 'No' }, 'page'), { quick })).end[0]).toMatchObject({ label: 'No' });
    });

    it('no label for a private question (no quick), typed text, or a quick question that ended otherwise', async () => {
      expect((await run(answered({ choice: 0, label: 'Yes' }, 'page'))).end[0]).not.toHaveProperty('label');
      expect((await run(answered({ text: 'wire it to ACCT-99' }, 'page'), { quick })).end[0]).not.toHaveProperty('label');
      expect(JSON.stringify((await run(answered({ text: 'wire it to ACCT-99' }, 'page'), { quick })).end)).not.toContain('ACCT');
      expect((await run(result({ status: 'timed_out' }), { quick })).end[0]).not.toHaveProperty('label');
    });

    it("'required' still fails a takeover no phone got, with no end report", async () => {
      const r = await run(result(), { delivered: 0, alerts: 'required' });
      expect(r.fail.mock.calls).toEqual([['alert_failed']]);
      expect(r.end).toEqual([]);
    });
  });

  it('passes quick to the alerter only when given, keeping the 5-argument call', async () => {
    const seen: unknown[][] = [];
    const alerter = (async (...a: unknown[]) => (seen.push(a), { delivered: 0 as const, problem: 'no_devices' as const })) as unknown as CloudAlerter;
    const t = { fail: vi.fn(), cancel: vi.fn(), ended: new Promise<never>(() => {}), joined: () => false };
    sendTakeoverAlert(alerter, true, info, 'x.com', t);
    sendTakeoverAlert(alerter, true, info, 'x.com', t, { question: 'q', choices: ['a', 'b'] });
    await settle();
    expect(seen[0]).toHaveLength(2);
    expect(seen[1]![2]).toEqual({ quick: { question: 'q', choices: ['a', 'b'] } });
  });
});
