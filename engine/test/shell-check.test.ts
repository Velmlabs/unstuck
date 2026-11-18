import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launchChrome } from '../src/browser/launcher';
import { waitForFirstTab } from './chromium';
import { connectCdp } from '../src/direct-cdp';
import { runCheck } from '../src/shell/check';

const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { executablePath(): string } };
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/test/fixtures/human-checks');

let browser: Awaited<ReturnType<typeof launchChrome>>;
let server: http.Server;
let site: string;
beforeAll(async () => {
  browser = await launchChrome({ path: chromium.executablePath(), isRoot: process.getuid?.() === 0 });
  await waitForFirstTab(Number(new URL(browser.cdpUrl).port));
  server = http.createServer((req, res) => {
    const name = (req.url ?? '/').split('?')[0]!.slice(1) || 'clear';
    const file = path.join(FIXTURES, `${name}.html`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fs.existsSync(file) ? fs.readFileSync(file) : '<!doctype html><title>Shop</title><h1>Shop</h1><p>Welcome, everything is in stock.</p>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await browser.stop();
  await new Promise((r) => server.close(r));
});

async function goto(pathName: string): Promise<{ title: string; url: string }> {
  const cdp = await connectCdp(browser.cdpUrl);
  await cdp.send('Page.enable');
  const loaded = new Promise((r) => cdp.on('Page.loadEventFired', r));
  await cdp.send('Page.navigate', { url: `${site}${pathName}` });
  await loaded;
  const state = await cdp.send<{ result: { value: { title: string; url: string } } }>('Runtime.evaluate', { expression: '({ title: document.title, url: location.href })', returnByValue: true });
  await cdp.close();
  return state.result.value;
}

async function check(args: string[], env: Record<string, string | undefined> = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += String(d)));
  stderr.on('data', (d) => (err += String(d)));
  const code = await runCheck(args, { stdout, stderr }, env);
  return { code, json: out ? JSON.parse(out) : null, err };
}

describe('unstuck check', () => {
  it('a clear page → exit 0 {status:"clear"}', async () => {
    await goto('/clear');
    const r = await check(['--cdp', browser.cdpUrl]);
    expect(r).toMatchObject({ code: 0, json: { status: 'clear' } });
  });

  it('a Cloudflare interstitial → exit 20 with kind, vendor, site and rule', async () => {
    await goto('/cloudflare-interstitial');
    const r = await check(['--cdp', browser.cdpUrl]);
    expect(r.code).toBe(20);
    expect(r.json).toEqual({ status: 'check_found', check: { kind: 'challenge', vendor: 'cloudflare', site: '127.0.0.1', rule: 'cloudflare.interstitial' } });
  });

  it('an approval prompt → kind approval; --rescue challenge ignores it', async () => {
    await goto('/approval-google');
    expect((await check(['--cdp', browser.cdpUrl])).json.check.kind).toBe('approval');
    expect((await check(['--cdp', browser.cdpUrl, '--rescue', 'challenge'])).json).toEqual({ status: 'clear' });
  });

  it('a login page found with --url of another path; without --url it is clear', async () => {
    await goto('/login?next=/account');
    const loginPath = '/login';
    expect((await check(['--cdp', browser.cdpUrl, '--url', `${site}/account`])).json.check).toMatchObject({ kind: 'login' });
    expect((await check(['--cdp', browser.cdpUrl])).json).toEqual({ status: 'clear' });
    expect(loginPath).toBe('/login');
  });

  it('UNSTUCK_CDP_URL is the default; with neither it is exit 2', async () => {
    await goto('/clear');
    expect((await check([], { UNSTUCK_CDP_URL: browser.cdpUrl })).code).toBe(0);
    const none = await check([]);
    expect(none.code).toBe(2);
    expect(none.json).toMatchObject({ error: 'no_cdp' });
  });

  it('bad flags and a bad --rescue are exit 2 with the error', async () => {
    expect((await check(['--cdp', browser.cdpUrl, '--nope'])).code).toBe(2);
    const bad = await check(['--cdp', browser.cdpUrl, '--rescue', 'captcha']);
    expect(bad).toMatchObject({ code: 2, json: { error: 'usage' } });
    expect(bad.json.message).toContain('unknown --rescue kind "captcha"');
  });

  it('an unreachable browser is exit 2 unreachable', async () => {
    expect((await check(['--cdp', 'http://127.0.0.1:1'])).json).toMatchObject({ error: 'unreachable' });
  });

  it("the tab's URL and title are unchanged after check", async () => {
    const before = await goto('/cloudflare-interstitial');
    await check(['--cdp', browser.cdpUrl]);
    const cdp = await connectCdp(browser.cdpUrl);
    const after = await cdp.send<{ result: { value: { title: string; url: string } } }>('Runtime.evaluate', { expression: '({ title: document.title, url: location.href })', returnByValue: true });
    await cdp.close();
    expect(after.result.value).toEqual(before);
  });
});

describe('unstuck-engine check (CLI dispatch)', () => {
  it('main routes check to the shell command', async () => {
    const { main } = await import('../src/cli');
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', (d) => (out += String(d)));
    const code = await main(['check', '--cdp', 'http://127.0.0.1:1'], { stdin: new PassThrough(), stdout, stderr: new PassThrough(), env: {}, assets: {} });
    expect(code).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ error: 'unreachable' });
  });
});
