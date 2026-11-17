import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createMemorySessionStore } from '@velmlabs/unstuck-core';
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import { createWrap } from '../src/browser/wrap';
import { UnstuckRescueError } from '../src/errors';
import { chromium } from './helpers';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/test/fixtures/human-checks');
const INTERSTITIAL = readFileSync(path.join(DIR, 'cloudflare-interstitial.html'), 'utf8');
const SHOP = '<!doctype html><title>Shop</title><h1>Shop</h1>';
const HOME = '<!doctype html><title>Home</title><h1>Home</h1><a id="go" href="/shop">Checkout</a>';

let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
beforeAll(async () => {
  browser = await puppeteer.launch({ executablePath: (chromium as unknown as { executablePath(): string }).executablePath(), args: ['--no-sandbox'] });
});
afterAll(async () => {
  await browser.close();
});

const result = (status: TakeoverResult['status']): TakeoverResult => ({ status, sessionId: 's1', url: 'u', durationS: 1 });

/** https://shop.example/shop is a Cloudflare interstitial until the request carries cf_clearance. */
async function shopPage() {
  // A context of its own per page: the default one would keep the clearance cookie from an earlier test.
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.host !== 'shop.example') return void req.respond({ status: 404, body: '' });
    const cleared = /cf_clearance=ok/.test(req.headers().cookie ?? '');
    if (url.pathname === '/shop' && !cleared) return void req.respond({ status: 403, contentType: 'text/html', body: INTERSTITIAL });
    return void req.respond({ status: 200, contentType: 'text/html', body: url.pathname === '/shop' ? SHOP : HOME });
  });
  return page;
}

const solve = async (page: any) => {
  await page.setCookie({ name: 'cf_clearance', value: 'ok', domain: 'shop.example', path: '/', httpOnly: true, secure: true });
  void page.evaluate(() => location.reload()).catch(() => {});
};

let takeover: ReturnType<typeof vi.fn>;
let wrap: ReturnType<typeof createWrap>;
beforeEach(() => {
  const store = createMemorySessionStore();
  takeover = vi.fn(async (page: unknown) => {
    await solve(page);
    return result('resolved');
  });
  wrap = createWrap({ takeover: takeover as never, store: () => store });
});

describe('wrap (Puppeteer)', () => {
  it('goto onto a challenge returns past it after the takeover', async () => {
    const page = wrap(await shopPage());
    await page.goto('https://shop.example/shop');
    expect(await page.title()).toBe('Shop');
    expect(page.unstuck.lastRescue).toMatchObject({ status: 'resolved', check: { vendor: 'cloudflare' } });
    expect(takeover).toHaveBeenCalledWith(page, expect.objectContaining({ reason: "Cloudflare asks to verify you're human on shop.example" }));
    await page.browserContext().close();
  });

  it('page.click that navigates onto a challenge is rescued', async () => {
    const page = wrap(await shopPage());
    await page.goto('https://shop.example/');
    await page.click('#go');
    expect(page.unstuck.lastRescue?.status).toBe('resolved');
    expect(await page.title()).toBe('Shop');
    await page.browserContext().close();
  });

  it("page.locator('a').click() is rescued", async () => {
    const page = wrap(await shopPage());
    await page.goto('https://shop.example/');
    await page.locator('a').setTimeout(5000).click();
    expect(page.unstuck.lastRescue?.status).toBe('resolved');
    expect(await page.title()).toBe('Shop');
    await page.browserContext().close();
  });

  it('a failed rescue throws UnstuckRescueError(still_blocked)', async () => {
    takeover.mockImplementation(async () => result('resolved'));
    const page = wrap(await shopPage());
    const err = await page.goto('https://shop.example/shop').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnstuckRescueError);
    expect(err).toMatchObject({ status: 'still_blocked' });
    await page.browserContext().close();
  });

  it('never takes over without a check', async () => {
    const page = wrap(await shopPage());
    await page.goto('https://shop.example/');
    await page.reload();
    await page.type('h1', 'x').catch(() => {});
    expect(page.unstuck.lastRescue).toBeNull();
    expect(takeover).not.toHaveBeenCalled();
    await page.browserContext().close();
  });

  it('the browser key is the Browser, and a probe tab opens in the same context', async () => {
    const { adapterFor } = await import('../src/browser/wrap');
    const page = await shopPage();
    const a = adapterFor(page);
    expect(a.browserKey(page)).toBe(browser);
    const tab = (await a.newPage(page)) as Awaited<ReturnType<typeof browser.newPage>>;
    expect(tab.browserContext()).toBe(page.browserContext());
    await tab.close();
    await page.browserContext().close();
  });
});
