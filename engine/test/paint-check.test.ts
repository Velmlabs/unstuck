import { describe, it, expect, vi, afterAll } from 'vitest';
import { PNG } from 'pngjs';
import type { CdpClient } from '@velmlabs/unstuck-core';
import { probeCaptchaPaint, serveProbePages, checkIframePaint } from '../src/browser/paint-check';
import { connectCdp } from '../src/direct-cdp';
import { startChromium, type DebugChromium } from './chromium';

let chrome: DebugChromium | undefined;
afterAll(() => chrome?.stop());

const whitePng = () => {
  const png = new PNG({ width: 400, height: 300 });
  png.data.fill(255);
  return PNG.sync.write(png).toString('base64');
};

describe('probeCaptchaPaint', () => {
  it('Chromium paints the probe iframe', async () => {
    chrome = await startChromium();
    const openTab = async (url: string) => {
      const tab = await connectCdp(chrome!.wsUrl, { createUrl: url });
      return { cdp: tab as CdpClient, close: () => tab.browser.send('Target.closeTarget', { targetId: tab.targetId }).then(() => tab.close(), () => tab.close()) };
    };
    expect(await probeCaptchaPaint(openTab)).toBe(true);
  }, 60_000);

  it('a tab whose screenshot is blank reports false', async () => {
    const tab: CdpClient = {
      send: async <T>(method: string, params?: object) => {
        if (method === 'Page.captureScreenshot') return { data: whitePng() } as T;
        const e = (params as { expression?: string })?.expression ?? '';
        if (e.includes('__childLoaded')) return { result: { value: true } } as T;
        return { result: { value: { x: 190, y: 140, dpr: 1 } } } as T;
      },
      on: () => () => {},
      onClose: () => () => {},
    };
    const close = vi.fn(async () => {});
    expect(await probeCaptchaPaint(async () => ({ cdp: tab, close }))).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('a tab that never loads the page reports unknown and is closed', async () => {
    const tab: CdpClient = { send: async <T>() => ({ result: { value: false } }) as T, on: () => () => {}, onClose: () => () => {} };
    const close = vi.fn(async () => {});
    expect(await probeCaptchaPaint(async () => ({ cdp: tab, close }), { loadWaitMs: 200 })).toBe('unknown');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a tab that cannot be opened reports unknown', async () => {
    expect(
      await probeCaptchaPaint(async () => {
        throw new Error('no browser');
      }),
    ).toBe('unknown');
  });

  it('serveProbePages serves a parent with a cross-origin child', async () => {
    const p = await serveProbePages();
    const html = await (await fetch(p.url)).text();
    expect(p.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(html).toMatch(/iframe id="child" src="http:\/\/localhost:\d+\/"/);
    await p.close();
    expect(typeof checkIframePaint).toBe('function');
  });
});
