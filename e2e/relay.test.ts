import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Unstuck, type TakeoverLink } from '@velmlabs/unstuck';
import { createEngine, createRelayTransport, type LinkInfo } from '@velmlabs/unstuck-core';
import { cdpFor, launchWithCdpPort, RELAY_KEY, startRelay, tapStart } from './relay-harness';
import { waitFramed } from './framed';

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const ENGINE = path.resolve(here, '../engine/dist/unstuck-engine');
const CAPTCHA = fs.readFileSync(path.join(here, 'fixtures/fake-captcha.html'));

let server: http.Server;
let site: string;
let agentBrowser: any;
let humanBrowser: any;
const relays: Record<string, { url: string; stop(): Promise<void> }> = {};

beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CAPTCHA));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  agentBrowser = await chromium.launch();
  humanBrowser = await chromium.launch();
  relays.node = await startRelay('node');
  relays.cloudflare = await startRelay('cloudflare');
}, 120_000);
afterAll(async () => {
  for (const r of Object.values(relays)) await r.stop();
  await agentBrowser?.close();
  await humanBrowser?.close();
  server?.close();
});

async function agentPage() {
  const page = await agentBrowser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(site);
  return page;
}

/** A phone-sized human opens the link, taps "I'm not a robot" on the live view, then Done. */
async function humanSolves(url: string, page: any, code?: string) {
  const ctx = await humanBrowser.newContext({ ...devices['iPhone 13'] });
  const human = await ctx.newPage();
  await human.goto(url);
  await tapStart(human);
  if (code) {
    await human.getByLabel('Enter the 6-digit code').fill(code);
    await human.getByRole('button', { name: 'Continue' }).click();
  }
  await waitFramed(human, 20_000);
  const target = await page.locator('#robot').boundingBox();
  const box = await human.locator('canvas').boundingBox();
  const scale = Math.min(box.width / 1280, box.height / 720);
  const x = box.x + (box.width - 1280 * scale) / 2 + (target.x + target.width / 2) * scale;
  const y = box.y + (box.height - 720 * scale) / 2 + (target.y + target.height / 2) * scale;
  await human.touchscreen.tap(x, y);
  await expect.poll(() => page.evaluate('window.clicks'), { timeout: 15_000 }).toBe(1);
  await human.getByRole('button', { name: 'Done' }).click();
  await ctx.close();
}

async function viaTsSdk(relay: 'node' | 'cloudflare', opts: { requireCode?: boolean } = {}) {
  const page = await agentPage();
  let link!: TakeoverLink;
  let arrived!: () => void;
  const got = new Promise<void>((r) => (arrived = r));
  const unstuck = new Unstuck({ enginePath: ENGINE, relay: relays[relay]!.url, agentKey: RELAY_KEY, onLink: (l) => ((link = l), arrived()), requireCode: opts.requireCode });
  const result = unstuck.takeover(page, { reason: 'Solve the test CAPTCHA', timeoutS: 60 });
  await got;
  expect(link.url).toMatch(new RegExp(`^${relays[relay]!.url.replace('ws://', 'http://')}/s/[A-Za-z0-9_-]{22}#t=[^&]+&k=`));
  await humanSolves(link.url, page, link.code);
  await expect(result).resolves.toMatchObject({ status: 'resolved' });
  await unstuck.close();
  await page.close();
}

describe('takeover through a relay, end to end', () => {
  it('TS SDK × Node relay', () => viaTsSdk('node'), 60_000);
  it('TS SDK × Cloudflare relay (wrangler dev)', () => viaTsSdk('cloudflare'), 60_000);
  it('TS SDK × Node relay with the six-digit code', () => viaTsSdk('node', { requireCode: true }), 60_000);

  it('in-process engine (no binary) × Cloudflare relay', async () => {
    const page = await agentPage();
    const links: LinkInfo[] = [];
    const engine = createEngine({ transport: createRelayTransport({ url: relays.cloudflare!.url, agentKey: RELAY_KEY }), onLink: (l) => links.push(l) });
    const result = engine.takeover(await cdpFor(page), { reason: 'Solve the test CAPTCHA', timeoutS: 60 });
    await expect.poll(() => links.length, { timeout: 20_000 }).toBe(1);
    await humanSolves(links[0]!.url, page);
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await engine.close();
    await page.close();
  }, 60_000);

  it('a phone that was away while the session ended says so when it comes back, instead of "Reconnecting"', async () => {
    const page = await agentPage();
    let link!: TakeoverLink;
    let arrived!: () => void;
    const got = new Promise<void>((r) => (arrived = r));
    const unstuck = new Unstuck({ enginePath: ENGINE, relay: relays.node!.url, agentKey: RELAY_KEY, onLink: (l) => ((link = l), arrived()) });
    const result = unstuck.takeover(page, { reason: 'Away test', timeoutS: 10 });
    await got;
    const ctx = await humanBrowser.newContext({ ...devices['iPhone 13'] });
    const human = await ctx.newPage();
    // Stand-in for iOS suspending Safari: the live socket is cut and new ones fail until the human is back.
    let away = false;
    const sockets: any[] = [];
    await human.routeWebSocket(/\/ws\//, (ws: any) => {
      if (away) return ws.close();
      ws.connectToServer();
      sockets.push(ws);
    });
    await human.goto(link.url);
    await tapStart(human);
    await waitFramed(human, 20_000);
    away = true;
    for (const ws of sockets) await ws.close();
    await expect.poll(() => human.getByText(/Reconnecting/).isVisible(), { timeout: 5_000 }).toBe(true);
    await expect(result).resolves.toMatchObject({ status: 'timed_out' }); // the session ends while the phone is away
    away = false;
    await human.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // back in Safari
    await expect.poll(() => human.getByText('This check has ended').isVisible(), { timeout: 5_000 }).toBe(true);
    await ctx.close();
    await unstuck.close();
    await page.close();
  }, 60_000);

  it('viewer on its own origin: the link opens it, it talks to the relay named in ?r=, and the relay never serves the page', async () => {
    const version = JSON.parse(fs.readFileSync(path.join(here, '../viewer/package.json'), 'utf8')).version as string;
    const hosted = path.join(here, '../viewer/dist-hosted/v', version);
    expect(fs.existsSync(path.join(hosted, 'index.html')), 'run pnpm --filter @velmlabs/unstuck-viewer build:hosted').toBe(true);
    // Stand-in for view.unstuck.sh: static files only, strict CSP that allows connecting to the relay.
    const relayPort = new URL(relays.node!.url).port;
    const viewerServer = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      const rel = p.startsWith(`/v/${version}/assets/`) ? p.slice(`/v/${version}/`.length) : /^\/v\/[^/]+\/s\/[A-Za-z0-9_-]+$/.test(p) ? 'index.html' : null;
      if (!rel) return void res.writeHead(404).end();
      res.writeHead(200, {
        'content-type': rel.endsWith('.js') ? 'text/javascript' : rel.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'self'; img-src 'self' blob: data:; connect-src 'self' ws://127.0.0.1:${relayPort} http://127.0.0.1:${relayPort}; style-src 'self'; script-src 'self'; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
      }).end(fs.readFileSync(path.join(hosted, rel)));
    });
    await new Promise<void>((r) => viewerServer.listen(0, '127.0.0.1', r));
    const viewerOrigin = `http://127.0.0.1:${(viewerServer.address() as AddressInfo).port}`;
    const pagesFromRelay: string[] = [];
    const prev = process.env.UNSTUCK_VIEWER_URL;
    process.env.UNSTUCK_VIEWER_URL = `${viewerOrigin}/v/${version}`;
    try {
      const page = await agentPage();
      let link!: TakeoverLink;
      let arrived!: () => void;
      const got = new Promise<void>((r) => (arrived = r));
      const unstuck = new Unstuck({ enginePath: ENGINE, relay: relays.node!.url, agentKey: RELAY_KEY, onLink: (l) => ((link = l), arrived()) });
      const result = unstuck.takeover(page, { reason: 'Solve the test CAPTCHA', timeoutS: 60 });
      await got;
      expect(link.url.startsWith(`${viewerOrigin}/v/${version}/s/`)).toBe(true);
      expect(new URL(link.url).searchParams.get('r')).toBe(relays.node!.url);
      const ctx = await humanBrowser.newContext({ ...devices['iPhone 13'] });
      ctx.on('request', (r: any) => {
        if (r.url().startsWith(relays.node!.url.replace('ws://', 'http://') + '/s/') && r.method() === 'GET') pagesFromRelay.push(r.url());
      });
      const errors: string[] = [];
      const human = await ctx.newPage();
      human.on('pageerror', (e: any) => errors.push(e.message));
      human.on('console', (m: any) => m.type() === 'error' && errors.push(m.text()));
      await human.goto(link.url);
      await tapStart(human);
      await waitFramed(human, 20_000);
      expect(await human.evaluate(() => [...document.querySelectorAll('script[src], link[rel=stylesheet]')].every((e) => e.getAttribute('integrity')?.startsWith('sha384-')))).toBe(true);
      expect(new URL(human.url()).hash).toBe(''); // the secret left the address bar
      await human.getByRole('button', { name: 'Done' }).click();
      await expect(result).resolves.toMatchObject({ status: 'resolved' });
      expect(pagesFromRelay).toEqual([]);
      expect(errors).toEqual([]);
      await ctx.close();
      await unstuck.close();
      await page.close();
    } finally {
      if (prev === undefined) delete process.env.UNSTUCK_VIEWER_URL;
      else process.env.UNSTUCK_VIEWER_URL = prev;
      viewerServer.close();
    }
  }, 60_000);

  it('Python SDK × Node relay', async () => {
    const child = spawn('uv', ['run', '--project', path.join(here, '../sdk-py'), 'python', path.join(here, 'py_agent.py'), site, relays.node!.url, RELAY_KEY, ENGINE], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const lines: any[] = [];
    readline.createInterface({ input: child.stdout! }).on('line', (l) => lines.push(JSON.parse(l)));
    await expect.poll(() => lines.length, { timeout: 30_000 }).toBeGreaterThan(0);
    // The Python agent's page is in its own browser: the human just needs to see it and tap Done.
    const ctx = await humanBrowser.newContext({ ...devices['iPhone 13'] });
    const human = await ctx.newPage();
    await human.goto(lines[0].url);
    await tapStart(human);
    await waitFramed(human, 20_000);
    await human.getByRole('button', { name: 'Done' }).click();
    await expect.poll(() => lines.length, { timeout: 20_000 }).toBe(2);
    expect(lines[1]).toMatchObject({ status: 'resolved' });
    await ctx.close();
  }, 90_000);

  it('MCP server × Node relay', async () => {
    const { browser, port } = await launchWithCdpPort(chromium);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(site);
    const { targetInfo } = await (await page.context().newCDPSession(page)).send('Target.getTargetInfo');
    const engine = spawn(ENGINE, ['--mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, UNSTUCK_RELAY_URL: relays.node!.url, UNSTUCK_AGENT_KEY: RELAY_KEY, UNSTUCK_CDP_URL: `127.0.0.1:${port}` },
    });
    let stderr = '';
    engine.stderr!.on('data', (d) => (stderr += d));
    const replies: any[] = [];
    readline.createInterface({ input: engine.stdout! }).on('line', (l) => replies.push(JSON.parse(l)));
    const send = (m: object) => engine.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } });
    await expect.poll(() => replies.length, { timeout: 10_000 }).toBe(1);
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'request_human_takeover', arguments: { reason: 'Solve the test CAPTCHA', target_id: targetInfo.targetId, timeout_s: 60 } } });
    await expect.poll(() => /→ (\S+)/.exec(stderr)?.[1], { timeout: 20_000 }).toBeTruthy();
    const url = /→ (\S+)/.exec(stderr)![1]!;
    expect(url.startsWith(relays.node!.url.replace('ws://', 'http://'))).toBe(true);
    await humanSolves(url, page);
    await expect.poll(() => replies.find((r) => r.id === 2), { timeout: 20_000 }).toBeTruthy();
    expect(JSON.parse(replies.find((r) => r.id === 2).result.content[0].text)).toMatchObject({ status: 'resolved' });
    engine.stdin!.end();
    await browser.close();
  }, 90_000);
});
