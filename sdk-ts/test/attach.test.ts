import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { attachPage, PageClosedError } from '../src/attach';
import { launch } from './helpers';
import type { Browser } from './helpers';

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
});

describe('attachPage', () => {
  it('attaches to a Playwright page and sends CDP commands', async () => {
    const page = await browser.newPage();
    const a = await attachPage(page);
    expect(a.pageId).toMatch(/^[a-z0-9-]{8,}$/);
    await expect(a.send('Runtime.evaluate', { expression: '1+1', returnByValue: true })).resolves.toMatchObject({ result: { value: 2 } });
    await a.detach();
    await page.close();
  });

  it('subscribes to CDP events', async () => {
    const page = await browser.newPage();
    const a = await attachPage(page);
    const got = vi.fn();
    a.subscribe('Runtime.consoleAPICalled', got);
    await a.send('Runtime.enable');
    await page.evaluate(() => console.log('hi'));
    await vi.waitFor(() => expect(got).toHaveBeenCalled());
    await a.detach();
    await page.close();
  });

  it('reports page close once', async () => {
    const page = await browser.newPage();
    const a = await attachPage(page);
    const closed = vi.fn();
    a.onClose(closed);
    await page.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith('page closed'));
    expect(closed).toHaveBeenCalledTimes(1);
    await expect(a.detach()).resolves.toBeUndefined();
  });

  it('Final I6: onClose registered after the page closed fires immediately', async () => {
    const page = await browser.newPage();
    const a = await attachPage(page);
    await page.close();
    const late = vi.fn();
    a.onClose(late);
    expect(late).toHaveBeenCalledWith('page closed');
    await a.detach();
  });

  it('Final I6: attaching to an already-closed page reports PageClosedError', async () => {
    const page = await browser.newPage();
    await page.close();
    await expect(attachPage(page)).rejects.toBeInstanceOf(PageClosedError);
  });

  it('reports a page crash', async () => {
    const page = await browser.newPage();
    const a = await attachPage(page);
    const closed = vi.fn();
    a.onClose(closed);
    (page as unknown as { emit(e: string): void }).emit('crash');
    expect(closed).toHaveBeenCalledWith('page crashed');
    await a.detach();
    await page.close();
  });

  it('supports Puppeteer-style pages (createCDPSession)', async () => {
    const listeners: Record<string, (p: unknown) => void> = {};
    const pageListeners: Record<string, () => void> = {};
    const session = {
      send: vi.fn(async (m: string) => ({ ok: m })),
      on: (e: string, cb: (p: unknown) => void) => void (listeners[e] = cb),
      detach: vi.fn(async () => {}),
    };
    const page = { createCDPSession: async () => session, on: (e: string, cb: () => void) => void (pageListeners[e] = cb), off: vi.fn(), url: () => 'https://x.test/' };
    const a = await attachPage(page);
    await expect(a.send('Page.enable')).resolves.toEqual({ ok: 'Page.enable' });
    const got = vi.fn();
    a.subscribe('Page.screencastFrame', got);
    listeners['Page.screencastFrame']!({ n: 1 });
    expect(got).toHaveBeenCalledWith({ n: 1 });
    const closed = vi.fn();
    a.onClose(closed);
    pageListeners.close!();
    expect(closed).toHaveBeenCalledWith('page closed');
    await a.detach();
    expect(session.detach).toHaveBeenCalled();
  });

  it('rejects objects that are not pages', async () => {
    await expect(attachPage({})).rejects.toThrow(new TypeError('Unsupported page object: pass a Playwright or Puppeteer Page'));
    await expect(attachPage(null)).rejects.toThrow(TypeError);
  });
});
