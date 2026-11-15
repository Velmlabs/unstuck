import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { freePort, RELAY_KEY, startRelay, waitHealthy } from './relay-harness';

// An agent in a Durable Object under `wrangler dev` drives a real Chromium over CDP and hands it to a person through relay-cloudflare.

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const CAPTCHA = fs.readFileSync(path.join(here, 'fixtures/fake-captcha.html'));
const WRANGLER = path.join(here, 'node_modules/.bin/wrangler');

let server: http.Server;
let site: string;
let cdpPort: number;
let agentBrowser: any;
let humanBrowser: any;
let relay: { url: string; stop(): Promise<void> } | undefined;
let worker: ChildProcess | undefined;
let agent: string;

beforeAll(async () => {
  server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CAPTCHA));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cdpPort = await freePort();
  agentBrowser = await chromium.launch({ args: [`--remote-debugging-port=${cdpPort}`] });
  humanBrowser = await chromium.launch();
  relay = await startRelay('cloudflare');
  const port = await freePort();
  const log = process.env.RELAY_LOG ? 'inherit' : 'ignore';
  worker = spawn(WRANGLER, ['dev', '--config', path.join(here, 'workers/wrangler.toml'), '--port', String(port), '--ip', '127.0.0.1', '--persist-to', path.join(here, 'workers/.wrangler/e2e')], {
    cwd: path.join(here, 'workers'),
    stdio: ['ignore', log, log],
    detached: true,
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' },
  });
  agent = `http://127.0.0.1:${port}`;
  await waitHealthy(agent, 90_000);
}, 180_000);
afterAll(async () => {
  if (worker?.pid) process.kill(-worker.pid, 'SIGTERM');
  await relay?.stop();
  await agentBrowser?.close();
  await humanBrowser?.close();
  server?.close();
});

/** Taps Start on a takeover link (the page connects only then). */
async function tapStart(p: any) {
  const b = p.getByRole('button', { name: 'Start takeover' });
  if (await b.isVisible()) await b.click();
}

/** Opens the fixture in the agent's Chromium at a path of its own, so the Worker can find that tab by URL. */
async function agentPage(name: string) {
  const page = await agentBrowser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${site}/${name}`);
  return page;
}

/** Starts the Durable Object's takeover and returns a poller for one of its endpoints. */
async function run(name: string, page: any, timeoutS?: number) {
  const res = await fetch(`${agent}/run?agent=${name}`, {
    method: 'POST',
    body: JSON.stringify({ cdpUrl: `http://127.0.0.1:${cdpPort}`, relay: relay!.url, agentKey: RELAY_KEY, pageUrl: page.url(), timeoutS }),
  });
  expect(res.status).toBe(202);
  return async (what: 'link' | 'result') => {
    const r = await fetch(`${agent}/${what}?agent=${name}`);
    return r.status === 204 ? null : await r.json();
  };
}

describe('takeover from a Durable Object under wrangler dev', () => {
  it('a person on a phone solves the CAPTCHA and the Durable Object gets resolved', async () => {
    const page = await agentPage('resolved');
    const poll = await run('resolved', page);
    let link: any = null;
    await expect.poll(async () => (link = await poll('link')), { timeout: 30_000, interval: 250 }).toBeTruthy();
    expect(link.url).toMatch(new RegExp(`^${relay!.url.replace('ws://', 'http://')}/s/[A-Za-z0-9_-]{22}#t=`));
    expect(link.reason).toBe('Solve the CAPTCHA');

    const ctx = await humanBrowser.newContext({ ...devices['iPhone 13'] });
    const human = await ctx.newPage();
    await human.goto(link.url);
    await tapStart(human);
    await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width! > 100, null, { timeout: 20_000 });
    const target = await page.locator('#robot').boundingBox();
    const box = await human.locator('canvas').boundingBox();
    const scale = Math.min(box.width / 1280, box.height / 720);
    const x = box.x + (box.width - 1280 * scale) / 2 + (target.x + target.width / 2) * scale;
    const y = box.y + (box.height - 720 * scale) / 2 + (target.y + target.height / 2) * scale;
    await human.touchscreen.tap(x, y);
    await expect.poll(() => page.evaluate('window.clicks'), { timeout: 15_000 }).toBe(1);
    await human.getByRole('button', { name: 'Done' }).click();

    await expect.poll(() => poll('result'), { timeout: 20_000, interval: 250 }).toMatchObject({ status: 'resolved', sessionId: link.sessionId });
    expect(await page.locator('#robot').textContent()).toBe('✓ verified');
    await ctx.close();
    await page.close();
  }, 90_000);

  it('nobody opens the link: the Durable Object gets timed_out', async () => {
    const page = await agentPage('timeout');
    const poll = await run('timeout', page, 5);
    await expect.poll(() => poll('link'), { timeout: 30_000, interval: 250 }).toBeTruthy();
    await expect.poll(() => poll('result'), { timeout: 20_000, interval: 250 }).toMatchObject({ status: 'timed_out' });
    await page.close();
  }, 60_000);
});
