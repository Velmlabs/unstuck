// Unstuck Browser end to end with Playwright: a wrapped page meets each vendor's check, the engine binary serves the
// link, a phone-sized person taps Done, and the agent's own call returns past the check.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Unstuck, UnstuckRescueError } from '@velmlabs/unstuck';
import { actAsHuman, chromium, ENGINE } from './examples/harness';
import { startChallengeSite, type ChallengeSite } from './browser/challenge-site';

let site: ChallengeSite;
let browser: any;
let home: string;
beforeAll(async () => {
  site = await startChallengeSite();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  site?.close();
});
beforeEach(() => {
  site.reset();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-e2e-home-'));
  vi.stubEnv('UNSTUCK_HOME', home);
});

/** A client whose person solves the check (unless `solve` is false) and taps Done on every link. */
function client(o: { solve?: boolean } = {}) {
  const links: string[] = [];
  const people: Promise<void>[] = [];
  const unstuck = new Unstuck({
    enginePath: ENGINE,
    onLink: (l) => {
      links.push(l.url);
      if (o.solve !== false) site.solve();
      people.push(actAsHuman(l.url, 'done'));
    },
  });
  return { unstuck, links, people: () => Promise.all(people) };
}

async function context() {
  const ctx = await browser.newContext();
  await site.vendorRoutes(ctx);
  return ctx;
}

describe('Unstuck Browser with Playwright', () => {
  it.each(['/cf', '/turnstile', '/recaptcha', '/hcaptcha', '/verify'])('Playwright wrap: %s → the person taps Done → the call returns past the check', async (p) => {
    const c = client();
    const ctx = await context();
    const page = c.unstuck.wrap(await ctx.newPage());
    await page.goto(site.url + p);
    expect(await page.title()).toBe('Shop');
    expect(page.unstuck.lastRescue?.status).toBe('resolved');
    expect(c.links).toHaveLength(1);
    await c.people();
    await c.unstuck.close();
    await ctx.close();
  });

  it('session memory: a second run with remember: true goes straight through (no link)', async () => {
    const first = client();
    const ctx = await context();
    const page = first.unstuck.wrap(await ctx.newPage(), { remember: true });
    await page.goto(`${site.url}/cf`);
    expect(page.unstuck.lastRescue?.status).toBe('resolved');
    await first.people();
    await first.unstuck.close();
    await ctx.close();
    expect(fs.readFileSync(path.join(home, 'profiles', 'default', 'sites.json'), 'utf8')).toContain('cf_clearance');

    site.reset();
    const second = client();
    const fresh = await context();
    const again = second.unstuck.wrap(await fresh.newPage(), { remember: true });
    await again.goto(`${site.url}/cf`);
    expect(await again.title()).toBe('Shop');
    expect(again.unstuck.lastRescue).toBeNull();
    expect(second.links).toHaveLength(0);
    await second.unstuck.close();
    await fresh.close();
  });

  it('rate limit: with maxRescuesPerHour: 2 the third check throws rescue_limited and opens no takeover', async () => {
    const c = client();
    for (let i = 0; i < 3; i++) {
      site.reset();
      const ctx = await context();
      const page = c.unstuck.wrap(await ctx.newPage(), { maxRescuesPerHour: 2 });
      if (i < 2) {
        await page.goto(`${site.url}/cf`);
        expect(page.unstuck.lastRescue?.status).toBe('resolved');
      } else {
        const err = await page.goto(`${site.url}/cf`).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(UnstuckRescueError);
        expect(err).toMatchObject({ status: 'rescue_limited' });
      }
      await ctx.close();
    }
    expect(c.links).toHaveLength(2);
    await c.people();
    await c.unstuck.close();
  });

  it('Done without solving → UnstuckRescueError still_blocked', async () => {
    const c = client({ solve: false });
    const ctx = await context();
    const page = c.unstuck.wrap(await ctx.newPage());
    const err = await page.goto(`${site.url}/cf`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnstuckRescueError);
    expect(err).toMatchObject({ status: 'still_blocked', check: { vendor: 'cloudflare' } });
    await c.people();
    await c.unstuck.close();
    await ctx.close();
  });

  it('an article about CAPTCHAs is not a check', async () => {
    const c = client();
    const ctx = await context();
    const page = c.unstuck.wrap(await ctx.newPage());
    await page.goto(`${site.url}/article`);
    expect(page.unstuck.lastRescue).toBeNull();
    expect(c.links).toHaveLength(0);
    await c.unstuck.close();
    await ctx.close();
  });
});
