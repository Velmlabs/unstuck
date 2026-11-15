import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Unstuck, type TakeoverLink } from '@velmlabs/unstuck';
import { createEngine, createRelayTransport, type LinkInfo } from '@velmlabs/unstuck-core';
import { cdpFor, RELAY_KEY, startRelay, tapStart } from './relay-harness';

// Frame credit on a slow phone link: the viewer is throttled to 1.5 Mbit/s down / 150 ms, the agent page repaints
// every animation frame and shows the time in its pixels. Without credit, frames queue up in front of the phone and
// what it shows falls further and further behind; with credit, it stays close to now.

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const ENGINE = path.resolve(here, '../engine/dist/unstuck-engine');
const CLOCK = fs.readFileSync(path.join(here, 'fixtures/clock.html'));
const THROTTLE = { offline: false, latency: 150, downloadThroughput: 1_500_000 / 8, uploadThroughput: 1_500_000 / 8 };
const MEASURE_MS = Number(process.env.CREDIT_MEASURE_MS ?? 10_000);
const MAX_LAG_MS = 1_500;
/** Noise cells per repaint: ~44 KB JPEG frames at 1280×720, quality 70 (a busy CAPTCHA page); 1.5 Mbit/s carries ~4 of them a second. */
const NOISE = 300;

let server: http.Server;
let site: string;
let agentBrowser: any;
let humanBrowser: any;
const relays: Record<string, { url: string; stop(): Promise<void> }> = {};

beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CLOCK));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/?noise=${NOISE}`;
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

/** How far behind the clock the phone's picture is, in ms (null: no readable clock on the canvas yet). */
function readLag(human: any): Promise<number | null> {
  return human.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || c.width < 480) return null;
    let t = 0;
    for (let i = 0; i < 6; i++) {
      const d = ctx.getImageData(i * 80 + 30, 30, 20, 20).data;
      let sum = 0;
      for (let p = 0; p < d.length; p += 4) sum += d[p]!;
      const nibble = Math.round((sum / (d.length / 4) - 8) / 16);
      if (nibble < 0 || nibble > 15) return null;
      t = t * 16 + nibble;
    }
    return ((Date.now() & 0xffffff) - t + 0x1000000) % 0x1000000;
  });
}

/** Opens the link on a throttled phone and samples the shown picture's lag for MEASURE_MS. */
async function measure(url: string): Promise<{ lags: number[]; frames: number }> {
  const ctx = await humanBrowser.newContext({ ...devices['iPhone 13'] });
  const human = await ctx.newPage();
  await human.goto(url);
  await tapStart(human);
  await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width! > 100, null, { timeout: 20_000 });
  const cdp = await ctx.newCDPSession(human);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', THROTTLE);
  const lags: number[] = [];
  const seen = new Set<number>();
  const end = Date.now() + MEASURE_MS;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 250));
    const lag = await readLag(human);
    if (lag === null) continue;
    lags.push(lag);
    seen.add(lag - Date.now()); // a new picture shows a new clock value (shifted by when it was read)
  }
  await human.getByRole('button', { name: 'Done' }).click();
  await ctx.close();
  return { lags, frames: seen.size };
}

function report(label: string, { lags, frames }: { lags: number[]; frames: number }) {
  const tail = lags.slice(-4);
  const last = tail.reduce((a, b) => a + b, 0) / tail.length;
  console.log(`[frame credit] ${label}: ${lags.length} samples, max lag ${Math.max(...lags)} ms, last ~${Math.round(last)} ms, ~${frames} distinct pictures`);
  console.log(`[frame credit] ${label}: lags ${lags.join(' ')}`);
  return last;
}

describe('frame credit on a throttled phone (1.5 Mbit/s, 150 ms)', () => {
  it('engine binary × Node relay: the picture stays close to now', async () => {
    const page = await agentBrowser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(site);
    let link!: TakeoverLink;
    let arrived!: () => void;
    const got = new Promise<void>((r) => (arrived = r));
    const unstuck = new Unstuck({ enginePath: ENGINE, relay: relays.node!.url, agentKey: RELAY_KEY, onLink: (l) => ((link = l), arrived()) });
    const result = unstuck.takeover(page, { reason: 'Frame credit', timeoutS: 60 });
    await got;
    const m = await measure(link.url);
    const last = report('binary × node', m);
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await unstuck.close();
    await page.close();
    expect(m.lags.length).toBeGreaterThan(10);
    expect(last).toBeLessThan(MAX_LAG_MS);
  }, 90_000);

  it('in-process engine × Cloudflare relay (no bufferedAmount on either hop): the picture stays close to now', async () => {
    const page = await agentBrowser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(site);
    const links: LinkInfo[] = [];
    const engine = createEngine({ transport: createRelayTransport({ url: relays.cloudflare!.url, agentKey: RELAY_KEY }), onLink: (l) => links.push(l) });
    const result = engine.takeover(await cdpFor(page), { reason: 'Frame credit', timeoutS: 60 });
    await expect.poll(() => links.length, { timeout: 20_000 }).toBe(1);
    const m = await measure(links[0]!.url);
    const last = report('in-process × cloudflare', m);
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await engine.close();
    await page.close();
    expect(m.lags.length).toBeGreaterThan(10);
    expect(last).toBeLessThan(MAX_LAG_MS);
  }, 90_000);
});
