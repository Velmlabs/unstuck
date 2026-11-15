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

/** A lag above this is a misread clock, not a real sample (the clock wraps every ~4.7 h). */
const MAX_PLAUSIBLE_LAG_MS = 60_000;
/**
 * Lag settles over the first seconds after the throttle goes on (data already in flight, the credit window filling):
 * growth is measured from the second after this warm-up to the last second (medians). Without credit, lag grows ~0.9 s
 * every second, so 5 s later it would be ~4.5 s over.
 */
const WARMUP_SAMPLES = 16; // 4 s at 4 samples a second
const MAX_GROWTH_MS = 750;
/** Hard cap on the last second's median lag. */
const MAX_LAG_MS = 3_000;
/**
 * At 1.5 Mbit/s the ~44 KB frames fit about 4 a second; unthrottled the phone shows 25+. Fewer new pictures a second than
 * this proves the throttle applied, so the lag bound can't pass vacuously on an unthrottled link.
 */
const MAX_THROTTLED_PICTURES_PER_S = 8;

/**
 * Installs a reader in the phone's page that decodes the clock from the canvas on every animation frame and counts how
 * often it changes (new pictures drawn). A nibble out of range (a JPEG artefact, or a frame mid-draw) is retried once
 * on the next animation frame before the sample is skipped.
 */
function installReader(human: any): Promise<void> {
  return human.evaluate(() => {
    const w = window as unknown as { __clock: { last: number | null; changes: number; reset(): void } };
    const decode = (): number | null => {
      const c = document.querySelector('canvas') as HTMLCanvasElement | null;
      const ctx = c?.getContext('2d', { willReadFrequently: true });
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
      return t;
    };
    const state = { last: null as number | null, changes: 0, retry: false, reset: () => void (state.changes = 0) };
    w.__clock = state;
    const tick = () => {
      const t = decode();
      if (t === null && !state.retry) state.retry = true; // try once more on the next frame
      else {
        state.retry = false;
        if (t !== null && t !== state.last) {
          if (state.last !== null) state.changes++;
          state.last = t;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** How far behind the clock the phone's picture is now, in ms (null: nothing plausible decoded yet). */
async function readLag(human: any): Promise<number | null> {
  const lag = await human.evaluate(() => {
    const last = (window as unknown as { __clock: { last: number | null } }).__clock.last;
    return last === null ? null : ((Date.now() & 0xffffff) - last + 0x1000000) % 0x1000000;
  });
  return lag === null || lag > MAX_PLAUSIBLE_LAG_MS ? null : lag;
}

const changes = (human: any, reset = false): Promise<number> =>
  human.evaluate((r: boolean) => {
    const c = (window as unknown as { __clock: { changes: number; reset(): void } }).__clock;
    const n = c.changes;
    if (r) c.reset();
    return n;
  }, reset);

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

interface Measurement {
  lags: number[];
  /** New pictures per second before and while throttled. */
  freePps: number;
  throttledPps: number;
}

/** Opens the link on the phone, notes its unthrottled picture rate, throttles it and samples the lag for MEASURE_MS. */
async function measure(url: string): Promise<Measurement> {
  const ctx = await humanBrowser.newContext({ ...devices['iPhone 13'] });
  const human = await ctx.newPage();
  await human.goto(url);
  await tapStart(human);
  await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width! > 100, null, { timeout: 20_000 });
  await installReader(human);
  await changes(human, true);
  await new Promise((r) => setTimeout(r, 2_000));
  const freePps = (await changes(human, true)) / 2;
  const cdp = await ctx.newCDPSession(human);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', THROTTLE);
  await changes(human, true);
  const started = Date.now();
  const lags: number[] = [];
  while (Date.now() - started < MEASURE_MS) {
    await new Promise((r) => setTimeout(r, 250));
    const lag = await readLag(human);
    if (lag !== null) lags.push(lag);
  }
  const throttledPps = (await changes(human)) / ((Date.now() - started) / 1000);
  await human.getByRole('button', { name: 'Done' }).click();
  await ctx.close();
  return { lags, freePps, throttledPps };
}

/** Logs the measurement and checks it: enough samples, the throttle applied, lag neither growing nor large. */
function check(label: string, m: Measurement) {
  const head = median(m.lags.slice(WARMUP_SAMPLES, WARMUP_SAMPLES + 4));
  const tail = median(m.lags.slice(-4));
  console.log(
    `[frame credit] ${label}: ${m.lags.length} samples; lag median after warm-up ${head} ms, last second ${tail} ms, max ${Math.max(...m.lags)} ms; ` +
      `pictures/s unthrottled ${m.freePps.toFixed(1)}, throttled ${m.throttledPps.toFixed(1)}`,
  );
  console.log(`[frame credit] ${label}: lags ${m.lags.join(' ')}`);
  expect(m.lags.length).toBeGreaterThan(WARMUP_SAMPLES + 12);
  expect(m.throttledPps).toBeGreaterThan(0.5); // the stream kept moving
  expect(m.throttledPps).toBeLessThan(MAX_THROTTLED_PICTURES_PER_S);
  expect(tail - head).toBeLessThan(MAX_GROWTH_MS);
  expect(tail).toBeLessThan(MAX_LAG_MS);
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
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await unstuck.close();
    await page.close();
    check('binary × node', m);
  }, 90_000);

  it('in-process engine × Cloudflare relay (no bufferedAmount on either hop): the picture stays close to now', async () => {
    const page = await agentBrowser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(site);
    const links: LinkInfo[] = [];
    const engine = createEngine({ transport: createRelayTransport({ url: relays.cloudflare!.url, agentKey: RELAY_KEY }), onLink: (l) => links.push(l) });
    const result = engine.takeover(await cdpFor(page), { reason: 'Frame credit', timeoutS: 60 });
    await expect.poll(() => links.length, { timeout: 20_000 }).toBe(1);
    const m = await measure(links[0]!.url);
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await engine.close();
    await page.close();
    check('in-process × cloudflare', m);
  }, 90_000);
});
