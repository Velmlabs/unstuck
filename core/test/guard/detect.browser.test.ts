import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CdpClient } from '../../src/cdp';
import { detectHumanCheck } from '../../src/guard/detect';
import { trackMainDocument } from '../../src/guard/main-document';
import type { CheckKind } from '@velmlabs/unstuck-protocol';

// Real Chromium: the vendor fixtures are served under https://shop.example/ and the vendor hosts through routing, so
// the in-page facts script and the main-document tracker are tested where they run.
interface Route {
  request(): { url(): string };
  fulfill(o: { status?: number; headers?: Record<string, string>; contentType?: string; body: string }): Promise<void>;
}
interface Session {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, h: (p: any) => void): void;
  off(event: string, h: (p: any) => void): void;
}
interface Page {
  goto(url: string): Promise<unknown>;
  context(): { newCDPSession(page: Page): Promise<Session>; route(glob: string, h: (r: Route) => Promise<void>): Promise<void> };
}
interface Browser {
  newPage(opts: object): Promise<Page>;
  close(): Promise<void>;
}
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as { chromium: { launch(): Promise<Browser> } };
const DIR = join(import.meta.dirname, '../fixtures/human-checks');

let browser: Browser;
let page: Page;
let cdp: CdpClient;
let tracker: Awaited<ReturnType<typeof trackMainDocument>>;
let headerFor: Record<string, { status: number; headers: Record<string, string> }> = {};

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const frame = url.host === 'challenges.cloudflare.com' ? 'turnstile' : url.host.endsWith('google.com') ? 'recaptcha-anchor' : url.host.endsWith('hcaptcha.com') ? 'hcaptcha' : null;
    if (frame) return route.fulfill({ contentType: 'text/html', body: readFileSync(join(DIR, 'frames', `${frame}.html`), 'utf8') });
    const name = url.pathname.slice(1);
    if (url.host !== 'shop.example' || !name.endsWith('.html')) return route.fulfill({ status: 404, body: '' });
    const extra = headerFor[name] ?? { status: name === 'forbidden-403.html' ? 403 : 200, headers: {} };
    return route.fulfill({ status: extra.status, headers: { 'content-type': 'text/html', ...extra.headers }, body: readFileSync(join(DIR, name), 'utf8') });
  });
  const session = await page.context().newCDPSession(page);
  cdp = {
    send: <T>(method: string, params?: object) => session.send(method, params) as Promise<T>,
    on: (event, h) => {
      session.on(event, h);
      return () => session.off(event, h);
    },
    onClose: () => () => {},
  };
  tracker = await trackMainDocument(cdp);
}, 60_000);
afterAll(async () => {
  tracker?.stop();
  await browser?.close();
});

const open = async (name: string) => {
  await page.goto(`https://shop.example/${name}`);
  return detectHumanCheck;
};

describe('detectHumanCheck on vendor fixtures (real Chromium)', () => {
  it.each([
    ['cloudflare-interstitial.html', 'cloudflare.interstitial', ['challenge']],
    ['cloudflare-turnstile.html', 'cloudflare.turnstile', ['challenge']],
    ['recaptcha-v2.html', 'recaptcha.v2', ['challenge']],
    ['hcaptcha.html', 'hcaptcha', ['challenge']],
    ['generic-verify.html', 'generic.heading', ['challenge']],
    ['otp.html', '2fa.code', ['challenge', '2fa']],
  ] as const)('%s → %s', async (name, ruleId, scope) => {
    await open(name);
    await expect(detectHumanCheck(cdp, { scope: scope as readonly CheckKind[], widgetGraceMs: 50, document: tracker.last() })).resolves.toMatchObject({ ruleId, site: 'shop.example' });
  });

  it('the interstitial served 503 with cf-mitigated is reported from the header', async () => {
    headerFor = { 'cloudflare-interstitial.html': { status: 503, headers: { 'cf-mitigated': 'challenge' } } };
    await open('cloudflare-interstitial.html');
    headerFor = {};
    expect(tracker.last()).toMatchObject({ status: 503, headers: { 'cf-mitigated': 'challenge' } });
    await expect(detectHumanCheck(cdp, { document: tracker.last() })).resolves.toMatchObject({ ruleId: 'cloudflare.mitigated', evidence: ['header cf-mitigated: challenge'] });
  });

  it.each(['recaptcha-v3-badge.html', 'article-about-captcha.html', 'forbidden-403.html', 'login.html'])('%s is not a check', async (name) => {
    await open(name);
    await expect(detectHumanCheck(cdp, { widgetGraceMs: 50, document: tracker.last() })).resolves.toBeNull();
  });

  // Review Focus 2
  it('a Turnstile that passes by itself within the grace period never pings a person', async () => {
    await open('turnstile-autopass.html');
    await expect(detectHumanCheck(cdp, { widgetGraceMs: 3000, document: tracker.last() })).resolves.toBeNull();
  }, 15_000);
});
