import { describe, it, expect, vi } from 'vitest';
import { sealAlert, newDeviceKeyPair, exportDevicePublicKey } from '@velmlabs/unstuck-protocol';
const O = 'https://view.unstuck.sh';
import { notificationFor, handleClick, type SwDeps } from '../src/sw-logic';
import type { DeviceStore } from '../src/device-store';

async function paired() {
  const kp = await newDeviceKeyPair();
  const pub = await exportDevicePublicKey(kp.publicKey);
  const store: DeviceStore = { get: async () => ({ deviceId: 'dev1', privateKey: kp.privateKey, deviceToken: 'tok' }), put: async () => {}, clear: async () => {} };
  return { pub, store };
}
const payload = { t: 'TOK', k: 'K'.repeat(43), reason: 'Solve the CAPTCHA', site: 'news.example.com', expiresAt: 1 };

describe('notificationFor', () => {
  it('takeover: unseals reason and site, names the key, opens the link', async () => {
    const { pub, store } = await paired();
    const blob = await sealAlert(pub, 'dev1', 'SESSION', payload);
    const link = `https://view.unstuck.sh/v/0.1.5/s/SESSION?r=wss://r.example&by=crawler#x=dev1.${blob}`;
    expect(await notificationFor({ kind: 'takeover', link, keyName: 'crawler-prod' }, store, O)).toEqual({
      title: 'Your agent needs you: Solve the CAPTCHA · news.example.com',
      options: { body: 'Sent by key: crawler-prod', data: { link } },
    });
  });

  it('takeover: falls back to the plain title when the link cannot be unsealed', async () => {
    const { store } = await paired();
    const link = 'https://view.unstuck.sh/v/0.1.5/s/SESSION#x=dev1.AAAA';
    expect((await notificationFor({ kind: 'takeover', link, keyName: 'k' }, store, O))?.title).toBe('Your agent needs you');
    const none: DeviceStore = { get: async () => null, put: async () => {}, clear: async () => {} };
    expect((await notificationFor({ kind: 'takeover', link, keyName: 'k' }, none, O))?.title).toBe('Your agent needs you');
    const broken: DeviceStore = { get: async () => { throw new Error('idb'); }, put: async () => {}, clear: async () => {} };
    expect((await notificationFor({ kind: 'takeover', link, keyName: 'k' }, broken, O))?.title).toBe('Your agent needs you');
  });

  it('takeover: leaves out an empty site and an empty key name', async () => {
    const { pub, store } = await paired();
    const blob = await sealAlert(pub, 'dev1', 'SESSION', { ...payload, site: '' });
    const link = `https://view.unstuck.sh/s/SESSION#x=dev1.${blob}`;
    expect(await notificationFor({ kind: 'takeover', link, keyName: '' }, store, O)).toEqual({
      title: 'Your agent needs you: Solve the CAPTCHA',
      options: { body: '', data: { link } },
    });
  });

  it("takeover: Cloud's title (cleaned) is the notification title; the unsealed reason and site go in the body", async () => {
    const { pub, store } = await paired();
    const blob = await sealAlert(pub, 'dev1', 'SESSION', payload);
    const link = `https://view.unstuck.sh/s/SESSION#x=dev1.${blob}`;
    expect(await notificationFor({ kind: 'takeover', link, keyName: 'crawler-prod', title: 'Crawler\u202e: Verify you\u2019re human\n' }, store, O)).toEqual({
      title: 'Crawler: Verify you\u2019re human',
      options: { body: 'Solve the CAPTCHA · news.example.com\nSent by key: crawler-prod', data: { link } },
    });
    // Not unsealed here: Cloud's title alone, with the key.
    const bad = 'https://view.unstuck.sh/s/SESSION#x=dev1.AAAA';
    expect(await notificationFor({ kind: 'takeover', link: bad, keyName: 'k', title: 'Crawler: Approve a sign-in' }, store, O)).toEqual({
      title: 'Crawler: Approve a sign-in',
      options: { body: 'Sent by key: k', data: { link: bad } },
    });
    // A link to another site is no link, but the title stays.
    expect(await notificationFor({ kind: 'takeover', link: 'https://evil.example/s/X', keyName: '', title: 'Crawler: Approve a sign-in' }, store, O)).toEqual({
      title: 'Crawler: Approve a sign-in',
      options: { body: '', data: {} },
    });
  });

  it('takeover: a title that is empty once cleaned, or not a string, gives the usual title', async () => {
    const { pub, store } = await paired();
    const blob = await sealAlert(pub, 'dev1', 'SESSION', payload);
    const link = `https://view.unstuck.sh/s/SESSION#x=dev1.${blob}`;
    for (const title of [' \u200b ', 42, null])
      expect((await notificationFor({ kind: 'takeover', link, keyName: 'k', title }, store, O)).title).toBe('Your agent needs you: Solve the CAPTCHA · news.example.com');
  });

  it('test alert: plain text, no link', async () => {
    const { store } = await paired();
    expect(await notificationFor({ kind: 'test' }, store, O)).toEqual({ title: 'Test alert from Unstuck', options: { body: '', data: {} } });
  });

  it('shows the generic notification, with no link, for an unknown payload or a link that is not on this origin', async () => {
    const { store } = await paired();
    for (const d of [null, undefined, 'x', 5, {}, { kind: 'nope' }, { kind: 'takeover' }, { kind: 'takeover', link: 'javascript:alert(1)' }, { kind: 'takeover', link: 'not a url' }])
      expect(await notificationFor(d, store, O)).toEqual({ title: 'Your agent needs you', options: { body: '', data: {} } });
    expect(await notificationFor({ kind: 'takeover', link: 'https://evil.example/s/A#x=a.b', keyName: 'k' }, store, O)).toEqual({
      title: 'Your agent needs you',
      options: { body: 'Sent by key: k', data: {} },
    });
    expect((await notificationFor({ kind: 'takeover', link: 'http://view.unstuck.sh/s/A', keyName: 'k' }, store, O)).options.data).toEqual({});
  });
  it('ignores a keyName that is not a string', async () => {
    const { store } = await paired();
    const r = await notificationFor({ kind: 'takeover', link: 'https://view.unstuck.sh/s/A#x=a.b', keyName: 7 }, store, O);
    expect(r.options.body).toBe('');
  });
});

describe('handleClick', () => {
  const deps = (): SwDeps & { opened: string[] } => {
    const opened: string[] = [];
    return { opened, origin: O, openWindow: async (u: string) => void opened.push(u) } as never;
  };
  it('opens the link', async () => {
    const d = deps();
    await handleClick({ link: 'https://view.unstuck.sh/s/A#x=a.b' }, d);
    expect(d.opened).toEqual(['https://view.unstuck.sh/s/A#x=a.b']);
  });
  it('does nothing for a test alert or a bad link', async () => {
    const d = deps();
    await handleClick({}, d);
    await handleClick(undefined, d);
    await handleClick({ link: 'javascript:alert(1)' }, d);
    await handleClick({ link: 'https://evil.example/s/A#x=a.b' }, d);
    expect(d.opened).toEqual([]);
  });
  it('is quiet when the window cannot be opened', async () => {
    await expect(handleClick({ link: 'https://view.unstuck.sh/s/A' }, { origin: O, openWindow: vi.fn(async () => { throw new Error('no'); }) })).resolves.toBeUndefined();
  });
});
