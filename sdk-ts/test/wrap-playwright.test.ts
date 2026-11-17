import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemorySessionStore, type SessionStore } from '@velmlabs/unstuck-core';
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import { createWrap } from '../src/browser/wrap';
import { UnstuckRescueError } from '../src/errors';
import { launch, type Browser } from './helpers';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/test/fixtures/human-checks');
const INTERSTITIAL = readFileSync(path.join(DIR, 'cloudflare-interstitial.html'), 'utf8');
const SHOP = '<!doctype html><title>Shop</title><h1>Shop</h1>';
const HOME = '<!doctype html><title>Home</title><h1>Home</h1><a href="/shop">Checkout</a><ul><li><a href="/shop">Checkout</a></li></ul>';

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
});

const result = (status: TakeoverResult['status'], detail?: string): TakeoverResult => ({ status, sessionId: 's1', url: 'u', durationS: 1, ...(detail ? { detail } : {}) });

/** A context where https://shop.example/shop is a Cloudflare interstitial until the request carries cf_clearance. */
async function shopContext() {
  const ctx = await browser.newContext();
  await ctx.route('**/*', async (route: any) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.host !== 'shop.example') return route.fulfill({ status: 404, body: '' });
    const cleared = /cf_clearance=ok/.test((await req.allHeaders()).cookie ?? '');
    if (url.pathname === '/shop' && !cleared) return route.fulfill({ status: 403, contentType: 'text/html', body: INTERSTITIAL });
    return route.fulfill({ contentType: 'text/html', body: url.pathname === '/shop' ? SHOP : HOME });
  });
  return ctx;
}

/** The person: solves the check (the site sets its clearance cookie, and the page reloads by itself). */
const solve = async (page: any) => {
  await page.context().addCookies([{ name: 'cf_clearance', value: 'ok', domain: 'shop.example', path: '/', httpOnly: true, secure: true }]);
  void page.evaluate(() => location.reload()).catch(() => {});
};

let store: SessionStore;
let takeover: ReturnType<typeof vi.fn>;
let wrap: ReturnType<typeof createWrap>;
beforeEach(() => {
  store = createMemorySessionStore();
  takeover = vi.fn(async (page: unknown) => {
    await solve(page);
    return result('resolved');
  });
  wrap = createWrap({ takeover: takeover as never, store: () => store });
});

describe('wrap (Playwright)', () => {
  it('goto onto a challenge returns past it after the takeover; lastRescue and onRescue say so', async () => {
    const ctx = await shopContext();
    const onRescue = vi.fn();
    const page = wrap(await ctx.newPage(), { onRescue });
    const res = await page.goto('https://shop.example/shop');
    expect(res).not.toBeNull();
    expect(await page.title()).toBe('Shop');
    expect(page.unstuck.lastRescue).toMatchObject({ status: 'resolved', check: { vendor: 'cloudflare' } });
    expect(onRescue).toHaveBeenCalledOnce();
    expect(takeover).toHaveBeenCalledWith(page, expect.objectContaining({ reason: "Cloudflare asks to verify you're human on shop.example" }));
    await ctx.close();
  });

  it('never throws and never takes over when no check is detected', async () => {
    const ctx = await shopContext();
    const page = wrap(await ctx.newPage());
    await page.goto('https://shop.example/');
    await page.fill('body', '').catch(() => {}); // not fillable: Playwright's own error, not ours
    await page.reload();
    expect(await page.title()).toBe('Home');
    expect(page.unstuck.lastRescue).toBeNull();
    await expect(page.unstuck.check()).resolves.toBeNull();
    expect(takeover).not.toHaveBeenCalled();
    await ctx.close();
  });

  it('a failed rescue throws UnstuckRescueError with status and detail; onRescueFail: return returns normally', async () => {
    takeover.mockImplementation(async () => result('resolved')); // "Done" without solving it
    const ctx = await shopContext();
    const page = wrap(await ctx.newPage());
    const err = await page.goto('https://shop.example/shop').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnstuckRescueError);
    expect(err).toMatchObject({ name: 'UnstuckRescueError', status: 'still_blocked', detail: 'cloudflare.interstitial', check: { site: 'shop.example' } });
    expect((err as Error).message).toBe('Unstuck could not get past a challenge on shop.example: still_blocked (cloudflare.interstitial)');
    const pageReturn = wrap(await ctx.newPage(), { onRescueFail: 'return' });
    expect(await pageReturn.goto('https://shop.example/shop')).not.toBeNull();
    expect(pageReturn.unstuck.lastRescue!.status).toBe('still_blocked');
    await ctx.close();
  });

  it('maps a failed takeover with alert_failed to alert_failed, and page_closed to failed', async () => {
    const ctx = await shopContext();
    takeover.mockImplementation(async () => result('failed', 'alert_failed'));
    const a = wrap(await ctx.newPage());
    await expect(a.goto('https://shop.example/shop')).rejects.toMatchObject({ status: 'alert_failed', detail: 'alert_failed' });
    takeover.mockImplementation(async () => result('failed', 'page_closed'));
    const b = wrap(await ctx.newPage());
    await expect(b.goto('https://shop.example/shop')).rejects.toMatchObject({ status: 'failed', detail: 'page_closed' });
    const e = await b.goto('https://shop.example/shop').catch((x: UnstuckRescueError) => x);
    expect(e.message).toBe('Unstuck could not get past a challenge on shop.example: failed (page_closed)');
    expect(e.event).toBe(b.unstuck.lastRescue);
    await ctx.close();
  });

  it('rescue_limited after maxRescuesPerHour', async () => {
    takeover.mockImplementation(async () => result('timed_out'));
    const ctx = await shopContext();
    const page = wrap(await ctx.newPage(), { maxRescuesPerHour: 1, onRescueFail: 'return' });
    await page.goto('https://shop.example/shop');
    expect(page.unstuck.lastRescue!.status).toBe('timed_out');
    await page.goto('https://shop.example/shop');
    expect(page.unstuck.lastRescue).toMatchObject({ status: 'rescue_limited' });
    expect(page.unstuck.lastRescue!.detail).toContain('at most 1 person-checks per hour');
    expect(takeover).toHaveBeenCalledOnce();
    await ctx.close();
  });

  it('remember: true stores the rescued site; a new context visiting it gets the cookie and no takeover', async () => {
    const ctx = await shopContext();
    const page = wrap(await ctx.newPage(), { remember: true });
    await page.goto('https://shop.example/shop');
    expect(page.unstuck.lastRescue!.status).toBe('resolved');
    expect((await store.load('shop.example'))!.cookies.map((c) => c.name)).toEqual(['cf_clearance']);
    await ctx.close();

    const fresh = await shopContext();
    const again = wrap(await fresh.newPage(), { remember: true });
    await again.goto('https://shop.example/shop');
    expect(await again.title()).toBe('Shop');
    expect(again.unstuck.lastRescue).toBeNull();
    expect(takeover).toHaveBeenCalledOnce();
    await again.unstuck.forgetSite('shop.example');
    expect(await store.load('shop.example')).toBeNull();
    await again.unstuck.rememberSite('shop.example');
    expect(await store.load('shop.example')).not.toBeNull();
    await again.unstuck.forgetAll();
    expect(await store.load('shop.example')).toBeNull();
    await fresh.close();
  });

  it('wrapping twice hooks once', async () => {
    const ctx = await shopContext();
    const raw = await ctx.newPage();
    const page = wrap(raw);
    const goto = page.goto;
    expect(wrap(page)).toBe(raw);
    expect(page.goto).toBe(goto);
    await page.goto('https://shop.example/shop');
    expect(takeover).toHaveBeenCalledOnce();
    await ctx.close();
  });

  it('page.unstuck.getSession returns the cookies only when asked', async () => {
    const ctx = await shopContext();
    const page = wrap(await ctx.newPage());
    await page.goto('https://shop.example/shop');
    expect(JSON.stringify(page.unstuck.lastRescue)).not.toContain('cf_clearance');
    const s = await page.unstuck.getSession();
    expect(s).toMatchObject({ site: 'shop.example', cookieHeader: 'cf_clearance=ok' });
    expect(s.userAgent).toContain('Mozilla');
    await ctx.close();
  });

  it('askHuman brings a person in for something only they can do', async () => {
    const ctx = await shopContext();
    const page = wrap(await ctx.newPage());
    await page.goto('https://shop.example/');
    await expect(page.unstuck.askHuman('Log in with your account')).resolves.toMatchObject({ status: 'resolved', check: { kind: 'ask' } });
    expect(takeover).toHaveBeenCalledWith(page, expect.objectContaining({ reason: 'Log in with your account' }));
    await ctx.close();
  });

  it('passes the takeover options through to each takeover', async () => {
    const ctx = await shopContext();
    const page = wrap(await ctx.newPage(), { timeoutS: 90, allowedSites: ['accounts.example'], alerts: false, requireCode: true });
    await page.goto('https://shop.example/shop');
    expect(takeover.mock.calls[0]![1]).toEqual({ reason: "Cloudflare asks to verify you're human on shop.example", timeoutS: 90, allowedSites: ['accounts.example'], alerts: false, requireCode: true });
    await ctx.close();
  });

  // Review Focus 1
  it('a locator click (getByRole) that lands on a challenge is rescued like page.click', async () => {
    const ctx = await shopContext();
    const page = wrap(await ctx.newPage());
    await page.goto('https://shop.example/');
    await page.getByRole('link', { name: 'Checkout' }).first().click();
    expect(page.unstuck.lastRescue?.status).toBe('resolved');
    expect(await page.title()).toBe('Shop');
    await ctx.close();
  });

  it('a chained locator (locator().filter().first()) is guarded too', async () => {
    const ctx = await shopContext();
    const page = wrap(await ctx.newPage());
    await page.goto('https://shop.example/');
    await page.locator('a').filter({ hasText: 'Checkout' }).first().click();
    expect(page.unstuck.lastRescue?.status).toBe('resolved');
    expect(await page.title()).toBe('Shop');
    await ctx.close();
  });

  it('page.click is guarded', async () => {
    const ctx = await shopContext();
    const page = wrap(await ctx.newPage());
    await page.goto('https://shop.example/');
    await page.click('li a');
    expect(page.unstuck.lastRescue?.status).toBe('resolved');
    await ctx.close();
  });

  it('a page that is neither Playwright nor Puppeteer is a TypeError', () => {
    expect(() => wrap({} as object)).toThrow(new TypeError('Unsupported page object: pass a Playwright or Puppeteer Page'));
  });
});
