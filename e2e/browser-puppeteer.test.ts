// Unstuck Browser end to end with Puppeteer (puppeteer-core on Playwright's Chromium).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { Unstuck } from '@velmlabs/unstuck';
import { actAsHuman, chromium, ENGINE } from './examples/harness';
import { startChallengeSite, vendorFrame, type ChallengeSite } from './browser/challenge-site';

let site: ChallengeSite;
let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
beforeAll(async () => {
  site = await startChallengeSite();
  browser = await puppeteer.launch({ executablePath: chromium.executablePath(), args: ['--no-sandbox'] });
});
afterAll(async () => {
  await browser?.close();
  site?.close();
});
beforeEach(() => {
  site.reset();
  vi.stubEnv('UNSTUCK_HOME', fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-e2e-home-')));
});

/** A page in a context of its own, with the vendor iframe hosts served from the fixtures. */
async function newPage() {
  const page = await (await browser.createBrowserContext()).newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const frame = vendorFrame(req.url());
    if (frame !== null) return void req.respond({ status: 200, contentType: 'text/html', body: frame });
    return void req.continue();
  });
  return page;
}

function client() {
  const links: string[] = [];
  const people: Promise<void>[] = [];
  const unstuck = new Unstuck({
    enginePath: ENGINE,
    onLink: (l) => {
      links.push(l.url);
      site.solve();
      people.push(actAsHuman(l.url, 'done'));
    },
  });
  return { unstuck, links, people: () => Promise.all(people) };
}

describe('Unstuck Browser with Puppeteer', () => {
  it.each(['/cf', '/turnstile'])('%s is resolved', async (p) => {
    const c = client();
    const page = c.unstuck.wrap(await newPage());
    await page.goto(site.url + p);
    expect(await page.title()).toBe('Shop');
    expect(page.unstuck.lastRescue?.status).toBe('resolved');
    await c.people();
    await c.unstuck.close();
    await page.browserContext().close();
  });

  it('session memory: the second run skips the check', async () => {
    const first = client();
    const page = first.unstuck.wrap(await newPage(), { remember: true });
    await page.goto(`${site.url}/cf`);
    expect(page.unstuck.lastRescue?.status).toBe('resolved');
    await first.people();
    await first.unstuck.close();
    await page.browserContext().close();
    site.reset();
    const second = client();
    const again = second.unstuck.wrap(await newPage(), { remember: true });
    await again.goto(`${site.url}/cf`);
    expect(await again.title()).toBe('Shop');
    expect(second.links).toHaveLength(0);
    await second.unstuck.close();
    await again.browserContext().close();
  });
});
