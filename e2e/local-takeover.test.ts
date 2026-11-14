import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Unstuck, type TakeoverLink } from '@velmlabs/unstuck';

const here = path.dirname(fileURLToPath(import.meta.url));
// Pre-installed Playwright (see sdk-ts/test/helpers.ts for why it is not a workspace dependency).
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const ENGINE = path.resolve(here, '../engine/dist/unstuck-engine');
const FIXTURES: Record<string, Buffer> = {
  '/': fs.readFileSync(path.join(here, 'fixtures/fake-captcha.html')),
  '/popup-opener': fs.readFileSync(path.join(here, 'fixtures/popup-opener.html')),
  '/popup': fs.readFileSync(path.join(here, 'fixtures/popup.html')),
  '/drag': fs.readFileSync(path.join(here, 'fixtures/drag-puzzles.html')),
};

let server: http.Server;
let site: string;
let agentBrowser: any;
let humanBrowser: any;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = FIXTURES[new URL(req.url ?? '/', 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }).end(body ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  agentBrowser = await chromium.launch();
  humanBrowser = await chromium.launch();
});
afterAll(async () => {
  await agentBrowser?.close();
  await humanBrowser?.close();
  server?.close();
});

async function startTakeover(opts: { timeoutS?: number; path?: string } = {}) {
  const page = await agentBrowser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(site + (opts.path ?? '').replace(/^\//, ''));
  let link!: TakeoverLink;
  let linkArrived!: () => void;
  const gotLink = new Promise<void>((r) => (linkArrived = r));
  const unstuck = new Unstuck({ enginePath: ENGINE, onLink: (l) => ((link = l), linkArrived()) });
  const result = unstuck.takeover(page, { reason: 'Solve the test CAPTCHA', timeoutS: opts.timeoutS ?? 60 });
  await gotLink;
  return { page, unstuck, result, link };
}

async function openHuman(url: string, wire?: Buffer[]) {
  const ctx = await humanBrowser.newContext({ ...devices['iPhone 13'] });
  const human = await ctx.newPage();
  // Capture what actually travels on the viewer's socket.
  if (wire) human.on('websocket', (ws: any) => ws.on('framereceived', (f: any) => wire.push(Buffer.from(f.payload))));
  await human.goto(url);
  return { ctx, human };
}

/** Where an agent-page point appears on the human's canvas (object-fit: contain letterboxing). */
async function canvasPointFor(human: any, pagePoint: { x: number; y: number }) {
  const box = await human.locator('canvas').boundingBox();
  const scale = Math.min(box.width / 1280, box.height / 720);
  const offX = (box.width - 1280 * scale) / 2;
  const offY = (box.height - 720 * scale) / 2;
  return { x: box.x + offX + pagePoint.x * scale, y: box.y + offY + pagePoint.y * scale };
}

async function centerOf(page: any, selector: string) {
  const b = await page.locator(selector).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

describe('local takeover end to end', () => {
  it('a phone-sized human solves the fake CAPTCHA, types unicode, taps Done → resolved (Review Focus 1 + 2)', async () => {
    const { page, unstuck, result, link } = await startTakeover();
    expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{22}#t=[^&]+&k=[A-Za-z0-9_-]{43}$/);

    const wire: Buffer[] = [];
    const { ctx, human } = await openHuman(link.url, wire);
    await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width! > 100, null, { timeout: 15_000 });
    // End-to-end encrypted even locally: no JPEG (FF D8) or JSON on the wire.
    await expect.poll(() => wire.filter((b) => b.length > 1000).length, { timeout: 10_000 }).toBeGreaterThan(0);
    const big = wire.filter((b) => b.length > 1000);
    expect(big.length).toBeGreaterThan(0);
    for (const b of wire) {
      // A plaintext frame is [0x01][w][h][FF D8 …]; a plaintext JSON message starts with '{'. Ciphertext is neither
      // (chance per message ~2^-24 for the frame shape; the '{' check covers JSON only together with no '"t":').
      expect(b[0] === 0x01 && b[5] === 0xff && b[6] === 0xd8).toBe(false);
      expect(b.includes(Buffer.from('"t":'))).toBe(false);
    }
    await expect(human.getByText('Solve the test CAPTCHA').count()).resolves.toBe(1);

    // Review Focus 2: someone else opening the same link is turned away; the human keeps control.
    const intruder = await openHuman(link.url);
    await intruder.human.getByRole('heading', { name: /already in use/i }).waitFor({ timeout: 10_000 });
    await intruder.ctx.close();

    const robot = await canvasPointFor(human, await centerOf(page, '#robot'));
    await human.touchscreen.tap(robot.x, robot.y);
    await expect.poll(() => page.evaluate('window.clicks'), { timeout: 10_000 }).toBe(1);

    const answer = await canvasPointFor(human, await centerOf(page, '#answer'));
    await human.touchscreen.tap(answer.x, answer.y);
    await expect.poll(() => page.evaluate("document.activeElement && document.activeElement.id"), { timeout: 10_000 }).toBe('answer');
    await human.getByRole('button', { name: 'Keyboard' }).click();
    await human.keyboard.insertText('héllo 日本');
    await expect.poll(() => page.inputValue('#answer'), { timeout: 10_000 }).toBe('héllo 日本');

    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved', sessionId: link.sessionId });
    await human.getByRole('heading', { name: /all done/i }).waitFor({ timeout: 10_000 });

    await ctx.close();
    await unstuck.close();
    await page.close();
  });

  it('Final I1: the human reloads mid-takeover and carries on (not locked out)', async () => {
    const { page, unstuck, result, link } = await startTakeover();
    const { ctx, human } = await openHuman(link.url);
    await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width! > 100, null, { timeout: 15_000 });
    await human.reload();
    try {
      await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width! > 100, null, { timeout: 15_000 });
    } catch (e) {
      // Say what the human is looking at, so a timeout is diagnosable.
      const seen = await human.evaluate(() => ({
        heading: document.querySelector('h1')?.textContent ?? null,
        status: document.querySelector('[role=status]')?.textContent ?? null,
        canvasWidth: (document.querySelector('canvas') as HTMLCanvasElement | null)?.width ?? null,
        stored: Object.keys(localStorage),
      }));
      throw new Error(`after reload the viewer showed ${JSON.stringify(seen)}: ${(e as Error).message}`);
    }
    expect(await human.getByRole('heading', { name: /already in use/i }).count()).toBe(0);
    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await ctx.close();
    await unstuck.close();
    await page.close();
  });

  it('Review Focus 4: the human follows a popup, verifies in it, and lands back on the page', async () => {
    const { page, unstuck, result, link } = await startTakeover({ path: '/popup-opener' });
    const { ctx, human } = await openHuman(link.url);
    await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width! > 100, null, { timeout: 15_000 });
    const opener = await canvasPointFor(human, await centerOf(page, '#open'));
    await human.touchscreen.tap(opener.x, opener.y);

    // The stream switches to the popup (its window is 500×400, not 1280×720).
    const popup = await page.waitForEvent('popup', { timeout: 10_000 });
    await popup.waitForLoadState();
    await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement).width < 1000, null, { timeout: 10_000 });
    const vp = popup.viewportSize() ?? (await popup.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    const b = await popup.locator('#verify').boundingBox();
    const box = await human.locator('canvas').boundingBox();
    const scale = Math.min(box.width / vp.width, box.height / vp.height);
    const x = box.x + (box.width - vp.width * scale) / 2 + (b.x + b.width / 2) * scale;
    const y = box.y + (box.height - vp.height * scale) / 2 + (b.y + b.height / 2) * scale;
    await human.touchscreen.tap(x, y);

    await expect.poll(() => page.evaluate('window.verified'), { timeout: 10_000 }).toBe(true);
    // Back on the original 1280-wide page.
    await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement).width > 1000, null, { timeout: 10_000 });
    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await ctx.close();
    await unstuck.close();
    await page.close();
  });

  it("Can't solve with a reason → cancelled with that reason", async () => {
    const { page, unstuck, result, link } = await startTakeover();
    const { ctx, human } = await openHuman(link.url);
    await human.getByRole('button', { name: "Can't solve" }).click();
    await human.getByLabel(/what went wrong/i).fill('blurry');
    await human.getByRole('button', { name: /send to agent/i }).click();
    await expect(result).resolves.toMatchObject({ status: 'cancelled', detail: 'blurry' });
    await human.getByRole('heading', { name: /handed back/i }).waitFor({ timeout: 10_000 });
    await ctx.close();
    await unstuck.close();
    await page.close();
  });

  it('nobody joins → timed_out, and the link then shows the expired page', async () => {
    const { page, unstuck, result, link } = await startTakeover({ timeoutS: 2 });
    await expect(result).resolves.toMatchObject({ status: 'timed_out' });
    const res = await fetch(link.url.split('#')[0]!);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('expired or is invalid');
    await unstuck.close();
    await page.close();
  });
});

/** A finger dragging across the human's screen, with a slightly wobbly, human-like path. */
async function fingerDrag(human: any, from: { x: number; y: number }, to: { x: number; y: number }, steps = 24) {
  const s = await human.context().newCDPSession(human);
  const point = (x: number, y: number) => ({ touchPoints: [{ x, y, id: 1 }] });
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', ...point(from.x, from.y) });
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    await s.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      ...point(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease + Math.sin(i) * 1.5),
    });
    await new Promise((r) => setTimeout(r, 16));
  }
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

describe('drag CAPTCHAs (sliders, drag-the-piece, drag and drop)', () => {
  it('a phone-sized human solves all three by dragging with a finger', async () => {
    const { page, unstuck, result, link } = await startTakeover({ path: '/drag' });
    const { ctx, human } = await openHuman(link.url);
    await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width === 1280, null, { timeout: 15_000 });

    const drag = async (fromSel: string, dx: number, dy: number) => {
      const from = await centerOf(page, fromSel);
      const a = await canvasPointFor(human, from);
      const b = await canvasPointFor(human, { x: from.x + dx, y: from.y + dy });
      await fingerDrag(human, a, b);
    };

    await drag('#knob', 250, 0);
    await expect.poll(() => page.evaluate('window.slider'), { timeout: 10_000 }).toBe('ok');

    const piece = await centerOf(page, '#piece');
    const hole = await centerOf(page, '#hole');
    await drag('#piece', hole.x - piece.x, hole.y - piece.y);
    await expect.poll(() => page.evaluate('window.puzzle'), { timeout: 10_000 }).toBe('ok');

    const card = await centerOf(page, '#card');
    const bin = await centerOf(page, '#bin');
    await drag('#card', bin.x - card.x, bin.y - card.y);
    await expect.poll(() => page.evaluate('window.dnd'), { timeout: 10_000 }).toBe('ok');

    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await unstuck.close();
    await ctx.close();
  }, 90_000);
});

