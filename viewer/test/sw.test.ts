import { describe, it, expect, vi } from 'vitest';
import { sealAlert, newDeviceKeyPair, exportDevicePublicKey } from '@velmlabs/unstuck-protocol';
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
    expect(await notificationFor({ kind: 'takeover', link, keyName: 'crawler-prod' }, store)).toEqual({
      title: 'Your agent needs you: Solve the CAPTCHA · news.example.com',
      options: { body: 'Sent by key: crawler-prod', data: { link } },
    });
  });

  it('takeover: falls back to the plain title when the link cannot be unsealed', async () => {
    const { store } = await paired();
    const link = 'https://view.unstuck.sh/v/0.1.5/s/SESSION#x=dev1.AAAA';
    expect((await notificationFor({ kind: 'takeover', link, keyName: 'k' }, store))?.title).toBe('Your agent needs you');
    const none: DeviceStore = { get: async () => null, put: async () => {}, clear: async () => {} };
    expect((await notificationFor({ kind: 'takeover', link, keyName: 'k' }, none))?.title).toBe('Your agent needs you');
    const broken: DeviceStore = { get: async () => { throw new Error('idb'); }, put: async () => {}, clear: async () => {} };
    expect((await notificationFor({ kind: 'takeover', link, keyName: 'k' }, broken))?.title).toBe('Your agent needs you');
  });

  it('takeover: leaves out an empty site and an empty key name', async () => {
    const { pub, store } = await paired();
    const blob = await sealAlert(pub, 'dev1', 'SESSION', { ...payload, site: '' });
    const link = `https://view.unstuck.sh/s/SESSION#x=dev1.${blob}`;
    expect(await notificationFor({ kind: 'takeover', link, keyName: '' }, store)).toEqual({
      title: 'Your agent needs you: Solve the CAPTCHA',
      options: { body: '', data: { link } },
    });
  });

  it('test alert: plain text, no link', async () => {
    const { store } = await paired();
    expect(await notificationFor({ kind: 'test' }, store)).toEqual({ title: 'Test alert from Unstuck', options: { body: '', data: {} } });
  });

  it('ignores anything else, and a takeover whose link is not a web URL', async () => {
    const { store } = await paired();
    for (const d of [null, undefined, 'x', 5, {}, { kind: 'nope' }, { kind: 'takeover' }, { kind: 'takeover', link: 'javascript:alert(1)', keyName: 'k' }, { kind: 'takeover', link: 'not a url', keyName: 'k' }])
      expect(await notificationFor(d, store)).toBeNull();
  });
  it('ignores a keyName that is not a string', async () => {
    const { store } = await paired();
    const r = await notificationFor({ kind: 'takeover', link: 'https://v.example/s/A#x=a.b', keyName: 7 }, store);
    expect(r?.options.body).toBe('');
  });
});

describe('handleClick', () => {
  const deps = (): SwDeps & { opened: string[] } => {
    const opened: string[] = [];
    return { opened, openWindow: async (u: string) => void opened.push(u) } as never;
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
    expect(d.opened).toEqual([]);
  });
  it('is quiet when the window cannot be opened', async () => {
    await expect(handleClick({ link: 'https://v.example/s/A' }, { openWindow: vi.fn(async () => { throw new Error('no'); }) })).resolves.toBeUndefined();
  });
});
