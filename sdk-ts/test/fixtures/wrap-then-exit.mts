// Child process: a wrapped page meets a challenge. The agent must stay alive through the paint check and the rescue
// (nobody comes: timed_out), print the status, then exit by itself.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Unstuck } from '../../src/index';

const { chromium } = createRequire(import.meta.url)('playwright');
const interstitial = readFileSync(new URL('../../../core/test/fixtures/human-checks/cloudflare-interstitial.html', import.meta.url), 'utf8');
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.route('https://shop.example/**', (route: any) => route.fulfill({ status: 403, contentType: 'text/html', body: interstitial }));
const unstuck = new Unstuck({ onLink: () => {} });
const page = unstuck.wrap(await ctx.newPage(), { onRescueFail: 'return', timeoutS: 10 });
await page.goto('https://shop.example/');
console.log(page.unstuck.lastRescue?.status ?? 'no rescue');
await unstuck.close();
await browser.close();
