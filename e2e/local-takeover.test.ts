import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Unstuck, type TakeoverLink } from '@velmlabs/unstuck';
import { waitFramed } from './framed';

/** Taps Start on a takeover link (the page connects only then; a reload by the same phone goes straight back in). */
async function tapStart(p: { getByRole: (role: 'button', o: { name: string }) => { isVisible: () => Promise<boolean>; click: () => Promise<void> } }) {
  const b = p.getByRole('button', { name: 'Start takeover' });
  if (await b.isVisible()) await b.click();
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Pre-installed Playwright (see sdk-ts/test/helpers.ts for why it is not a workspace dependency).
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const ENGINE = path.resolve(here, '../engine/dist/unstuck-engine');
const FIXTURES: Record<string, Buffer> = {
  '/': fs.readFileSync(path.join(here, 'fixtures/fake-captcha.html')),
  '/popup-opener': fs.readFileSync(path.join(here, 'fixtures/popup-opener.html')),
  '/popup': fs.readFileSync(path.join(here, 'fixtures/popup.html')),
  '/drag': fs.readFileSync(path.join(here, 'fixtures/drag-puzzles.html')),
  '/otp': fs.readFileSync(path.join(here, 'fixtures/otp.html')),
  '/long': fs.readFileSync(path.join(here, 'fixtures/long-page.html')),
};

let server: http.Server;
let site: string;
let port = 0;
/** Requests the page lock must stop before they ever leave the agent's browser. */
let secretHits = 0;
let agentBrowser: any;
let humanBrowser: any;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    if (pathname === '/secret') secretHits++;
    if (pathname === '/links' || pathname === '/next') {
      const big = 'style="display:block;margin:40px;padding:40px;font-size:40px"';
      return void res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<!doctype html><title>${pathname}</title><a id="away" ${big} href="http://localhost:${port}/secret">Your inbox</a><a id="same" ${big} href="/next">Next step</a><a id="blank" ${big} target="_blank" href="http://localhost:${port}/secret">Open inbox in a new tab</a>`,
      );
    }
    const body = FIXTURES[pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }).end(body ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  site = `http://127.0.0.1:${port}/`;
  agentBrowser = await chromium.launch();
  humanBrowser = await chromium.launch();
});
afterAll(async () => {
  await agentBrowser?.close();
  await humanBrowser?.close();
  server?.close();
});

async function startTakeover(opts: { timeoutS?: number; path?: string; reason?: string; viewport?: { width: number; height: number } } = {}) {
  const page = await agentBrowser.newPage({ viewport: opts.viewport ?? { width: 1280, height: 720 } });
  await page.goto(site + (opts.path ?? '').replace(/^\//, ''));
  let link!: TakeoverLink;
  let linkArrived!: () => void;
  const gotLink = new Promise<void>((r) => (linkArrived = r));
  const unstuck = new Unstuck({ enginePath: ENGINE, onLink: (l) => ((link = l), linkArrived()) });
  const result = unstuck.takeover(page, { reason: opts.reason ?? 'Solve the test CAPTCHA', timeoutS: opts.timeoutS ?? 60 });
  await gotLink;
  return { page, unstuck, result, link };
}

async function openHuman(url: string, wire?: Buffer[]) {
  const ctx = await humanBrowser.newContext({ ...devices['iPhone 13'] });
  const human = await ctx.newPage();
  // Capture what actually travels on the viewer's socket.
  if (wire) human.on('websocket', (ws: any) => ws.on('framereceived', (f: any) => wire.push(Buffer.from(f.payload))));
  await human.goto(url);
  await tapStart(human);
  return { ctx, human };
}

/** Where an agent-page point appears on the human's canvas (object-fit: contain letterboxing). */
async function canvasPointFor(human: any, pagePoint: { x: number; y: number }, page = { width: 1280, height: 720 }) {
  const box = await human.locator('canvas').boundingBox();
  const scale = Math.min(box.width / page.width, box.height / page.height);
  const offX = (box.width - page.width * scale) / 2;
  const offY = (box.height - page.height * scale) / 2;
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
    await waitFramed(human, 15_000);
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
    // In: the engine's ready stored the resume key (a canvas exists before that, at the default 300px width).
    await human.waitForFunction(() => Object.keys(localStorage).some((k) => k.startsWith('unstuck:resume:')), null, { timeout: 15_000 });
    await human.reload();
    try {
      await waitFramed(human, 15_000);
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
    await waitFramed(human, 15_000);
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

  it('page lock: a tap on a link to another site never leaves the agent\'s browser; same-site links still work', async () => {
    const { page, unstuck, result, link } = await startTakeover({ path: '/links' });
    const { ctx, human } = await openHuman(link.url);
    await waitFramed(human, 20_000);
    const tapOn = async (selector: string) => {
      const p = await canvasPointFor(human, await centerOf(page, selector));
      await human.touchscreen.tap(p.x, p.y);
    };
    await tapOn('#away');
    await new Promise((r) => setTimeout(r, 1500));
    expect(secretHits).toBe(0);
    expect(page.url()).toBe(site + 'links');
    // A link that opens another site in a new tab: the popup is closed, never shown, and the page stays put.
    const opened = new Promise((r) => page.context().once('page', r));
    await tapOn('#blank');
    await opened; // the tap really opened the other site in a new tab
    await expect.poll(() => page.context().pages().length, { timeout: 10_000 }).toBe(1);
    expect(page.url()).toBe(site + 'links');
    await tapOn('#same');
    await expect.poll(() => page.url(), { timeout: 10_000 }).toBe(site + 'next');
    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await ctx.close();
    await unstuck.close();
    await page.close();
  }, 60_000);

  it('a long reason never pushes Done or the countdown off a phone screen', async () => {
    const reason = 'Alerts check: open from Telegram, type in a field, then tap Done when the page looks right';
    const { page, unstuck, result, link } = await startTakeover({ reason });
    const { ctx, human } = await openHuman(link.url);
    await human.getByText(reason).waitFor({ timeout: 20_000 });
    const width = human.viewportSize()!.width;
    expect(await human.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    for (const el of [human.getByRole('button', { name: 'Done' }), human.getByTestId('countdown'), human.getByRole('button', { name: 'Help' })]) {
      const box = (await el.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    // Help's tooltip (a long-press) stays on screen, clear of the right edge.
    const hb = (await human.getByRole('button', { name: 'Help' }).boundingBox())!;
    const cdp = await human.context().newCDPSession(human);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: hb.x + hb.width / 2, y: hb.y + hb.height / 2, id: 1 }] });
    await human.getByRole('tooltip').waitFor({ timeout: 5_000 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const tb = (await human.getByRole('tooltip').boundingBox())!;
    expect(tb.x).toBeGreaterThanOrEqual(0);
    expect(tb.x + tb.width).toBeLessThanOrEqual(width - 4);
    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await ctx.close();
    await unstuck.close();
    await page.close();
  }, 60_000);

  it('a link preview or scanner that opens the link in a real browser (never tapping Start) does not use it up', async () => {
    const { unstuck, result, link } = await startTakeover();
    // The "preview": a real browser loads the page with the full link, runs its scripts, and never taps.
    const preview = await humanBrowser.newContext();
    const bot = await preview.newPage();
    const sockets: string[] = [];
    bot.on('websocket', (ws: any) => sockets.push(ws.url()));
    await bot.goto(link.url);
    expect(await bot.getByRole('button', { name: 'Start takeover' }).isVisible()).toBe(true);
    await bot.waitForTimeout(1500);
    expect(sockets).toEqual([]); // it never connected, so it saw no screen and took nothing
    await preview.close();
    // The person opens the same link afterwards and gets in normally.
    const { ctx, human } = await openHuman(link.url);
    await waitFramed(human, 15_000);
    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await unstuck.close();
    await ctx.close();
  }, 60_000);

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

describe('zoom on a phone', () => {
  const transform = (human: any) => human.evaluate(() => (document.querySelector('canvas') as HTMLCanvasElement).style.transform);
  /** Two fingers spreading apart around a point (real multi-touch through CDP: Playwright has no pinch). */
  async function pinchOut(human: any, at: { x: number; y: number }, from: number, to: number, steps = 10) {
    const s = await human.context().newCDPSession(human);
    const points = (d: number) => ({ touchPoints: [{ x: at.x - d / 2, y: at.y, id: 1 }, { x: at.x + d / 2, y: at.y, id: 2 }] });
    await s.send('Input.dispatchTouchEvent', { type: 'touchStart', ...points(from) });
    for (let i = 1; i <= steps; i++) {
      await s.send('Input.dispatchTouchEvent', { type: 'touchMove', ...points(from + ((to - from) * i) / steps) });
      await new Promise((r) => setTimeout(r, 16));
    }
    await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  it('zoomed in with + (and by pinching), a tap still lands on the right element of the page', async () => {
    const { page, unstuck, result, link } = await startTakeover();
    // Where the page really got each click, and on what.
    await page.evaluate(() => {
      (window as any).hits = [];
      document.addEventListener('click', (e) => (window as any).hits.push({ id: (e.target as HTMLElement).id, x: e.clientX, y: e.clientY }), true);
    });
    const { ctx, human } = await openHuman(link.url);
    await waitFramed(human, 15_000);
    const fitBox = await human.locator('canvas').boundingBox();
    // The rail's icons sit in the middle of their buttons (a general .btn padding once pushed them 3 px right).
    const offCentre = await human.evaluate(() =>
      [...document.querySelectorAll('.stage-controls button')].map((b) => {
        const a = b.getBoundingClientRect();
        const s = b.querySelector('svg')!.getBoundingClientRect();
        return Math.abs(s.left - a.left - (a.right - s.right));
      }),
    );
    expect(offCentre.length).toBe(6); // zoom in, out, fit; scroll up, down; Drag mode
    for (const d of offCentre) expect(d).toBeLessThanOrEqual(1);
    // The whole rail fits on the phone's mirror, and Help in the top bar is on screen too.
    const rail = await human.locator('.stage-controls').boundingBox();
    const stage = await human.locator('.stage').boundingBox();
    expect(rail.y).toBeGreaterThanOrEqual(stage.y);
    expect(rail.y + rail.height).toBeLessThanOrEqual(stage.y + stage.height);
    const help = await human.getByRole('button', { name: 'Help' }).boundingBox();
    expect(help.x + help.width).toBeLessThanOrEqual(human.viewportSize()!.width);

    await human.getByRole('button', { name: 'Zoom in' }).tap();
    await human.getByRole('button', { name: 'Zoom in' }).tap();
    await expect.poll(() => transform(human), { timeout: 5_000 }).toMatch(/scale\(2\)$/);
    const zoomedBox = await human.locator('canvas').boundingBox();
    expect(zoomedBox.width).toBeCloseTo(fitBox.width * 2, 0);
    // The zoomed canvas box is the same affine map the viewer uses, so the letterbox maths still finds the element.
    const robot = await centerOf(page, '#robot');
    const at = await canvasPointFor(human, robot);
    await human.touchscreen.tap(at.x, at.y);
    await expect.poll(() => page.evaluate('window.clicks'), { timeout: 10_000 }).toBe(1);
    const hit = (await page.evaluate('window.hits'))[0];
    expect(hit.id).toBe('robot');
    // At 2× on a 390 px phone one CSS px is ~1.6 page px: the click lands within a couple of px of where we aimed.
    expect(Math.abs(hit.x - robot.x)).toBeLessThan(3);
    expect(Math.abs(hit.y - robot.y)).toBeLessThan(3);

    // Fit, then pinch out around the button: zoomed, and nothing reached the page.
    await human.getByRole('button', { name: 'Fit page to screen' }).tap();
    await expect.poll(() => transform(human), { timeout: 5_000 }).toBe('');
    const atFit = await canvasPointFor(human, robot);
    await pinchOut(human, atFit, 60, 240);
    await expect.poll(() => transform(human), { timeout: 5_000 }).toMatch(/scale\(([2-4](\.\d+)?)\)$/);
    await new Promise((r) => setTimeout(r, 500));
    expect(await page.evaluate('window.hits.length')).toBe(1);
    const again = await canvasPointFor(human, robot);
    await human.touchscreen.tap(again.x, again.y);
    await expect.poll(() => page.evaluate('window.clicks'), { timeout: 10_000 }).toBe(2);
    expect((await page.evaluate('window.hits'))[1].id).toBe('robot');

    await human.getByRole('button', { name: 'Done' }).tap();
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await unstuck.close();
    await ctx.close();
    await page.close();
  }, 90_000);
});

/**
 * A finger dragging across the human's screen, with a slightly wobbly, human-like path. With `holdMs` the finger rests
 * where it landed that long before it moves (press and hold, then drag); without it, it moves at once (a swipe, or a
 * drag in Drag mode).
 */
async function fingerDrag(
  human: any,
  from: { x: number; y: number },
  to: { x: number; y: number },
  { steps = 24, flick = false, holdMs = 0, beforeLift }: { steps?: number; flick?: boolean; holdMs?: number; beforeLift?: () => Promise<void> } = {},
) {
  const s = await human.context().newCDPSession(human);
  const point = (x: number, y: number) => ({ touchPoints: [{ x, y, id: 1 }] });
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', ...point(from.x, from.y) });
  if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // A flick keeps its speed to the end (most moves land inside the viewer's move throttle); otherwise ease in and out.
    const ease = flick ? t : t * t * (3 - 2 * t);
    await s.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      ...point(from.x + (to.x - from.x) * ease, from.y + (to.y - from.y) * ease + Math.sin(i) * 1.5),
    });
    await new Promise((r) => setTimeout(r, flick ? 0 : 16));
  }
  await beforeLift?.();
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

describe('drag CAPTCHAs (sliders, jigsaw slider, drag-the-piece, drag and drop)', () => {
  it('a phone-sized human solves all four with a finger: press and hold then drag, or swipes in Drag mode', async () => {
    const { page, unstuck, result, link } = await startTakeover({ path: '/drag' });
    const { ctx, human } = await openHuman(link.url);
    await waitFramed(human, 15_000);

    const drag = async (fromSel: string, dx: number, dy: number, o: { flick?: boolean; holdMs?: number; beforeLift?: () => Promise<void> } = {}) => {
      const from = await centerOf(page, fromSel);
      const a = await canvasPointFor(human, from);
      const b = await canvasPointFor(human, { x: from.x + dx, y: from.y + dy });
      await fingerDrag(human, a, b, { steps: o.flick ? 10 : 24, ...o });
    };

    // A plain swipe over the slider moves (nothing to scroll here) and leaves the slider alone.
    await drag('#knob', 250, 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(await page.evaluate('window.slider')).toBe('idle');
    expect(await page.evaluate("document.getElementById('knob').style.left")).toBe('');

    // Press and hold, then drag (the hold engages at 350 ms).
    await drag('#knob', 250, 0, { holdMs: 500 });
    await expect.poll(() => page.evaluate('window.slider'), { timeout: 10_000 }).toBe('ok');

    const piece = await centerOf(page, '#piece');
    const hole = await centerOf(page, '#hole');
    await drag('#piece', hole.x - piece.x, hole.y - piece.y, { holdMs: 500 });
    await expect.poll(() => page.evaluate('window.puzzle'), { timeout: 10_000 }).toBe('ok');

    // Drag mode: a swipe drags at once.
    const dragMode = human.getByRole('button', { name: 'Drag mode' });
    expect(await dragMode.getAttribute('aria-pressed')).toBe('false');
    await dragMode.tap();
    await expect.poll(() => dragMode.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true');

    // A strict jigsaw slider (±4 px, position from the last mousemove), dragged with a quick flick that ends fast.
    // While the finger rests before lifting, the page already shows the piece where the finger is (what the person
    // lines up by eye), not where an earlier, throttled move left it.
    await drag('#jknob', 173, 0, {
      flick: true,
      beforeLift: async () => {
        const at = () => page.evaluate("parseFloat(document.getElementById('jpiece').style.left)") as Promise<number>;
        await expect.poll(async () => Math.abs((await at()) - 173), { timeout: 2_000 }).toBeLessThanOrEqual(4);
      },
    });
    await expect.poll(() => page.evaluate('window.jigsaw'), { timeout: 10_000 }).toBe('ok');

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

describe('swipe to move', () => {
  it('on a page taller than its window, a one-finger swipe up scrolls the agent page and clicks nothing; then a tap on the bottom button works', async () => {
    const size = { width: 390, height: 720 };
    const { page, unstuck, result, link } = await startTakeover({ path: '/long', viewport: size });
    const { ctx, human } = await openHuman(link.url);
    await waitFramed(human, 15_000);
    const box = await human.locator('canvas').boundingBox();
    const x = box.x + box.width / 2;
    // Swipes up from low on the mirror (over the tiles) until the page is at its bottom.
    const maxY = (await page.evaluate('document.documentElement.scrollHeight - innerHeight')) as number;
    expect(maxY).toBeGreaterThan(500);
    // The page scrolls by the finger's distance in page px (screen px × page width / the page image's width on
    // screen): the content stays under the finger.
    const shown = Math.min(box.width / size.width, box.height / size.height);
    const from = box.y + box.height * 0.8;
    const to = box.y + box.height * 0.2;
    await fingerDrag(human, { x, y: from }, { x, y: to }, { steps: 16 });
    const lifted = from - (to + Math.sin(16) * 1.5); // fingerDrag's last point carries its wobble
    // Every wheel has arrived once the page stops moving (the last one goes at the lift).
    await expect.poll(() => page.evaluate('scrollY'), { timeout: 5_000 }).toBeGreaterThan(0);
    let first = -1;
    await expect
      .poll(async () => {
        const was = first;
        await new Promise((r) => setTimeout(r, 150));
        first = (await page.evaluate('scrollY')) as number;
        return first === was;
      }, { timeout: 5_000 })
      .toBe(true);
    expect(Math.abs(first - lifted / shown)).toBeLessThanOrEqual(3);
    let before = first;
    for (let i = 0; i < 8 && before < maxY; i++) {
      await fingerDrag(human, { x, y: box.y + box.height * 0.8 }, { x, y: box.y + box.height * 0.2 }, { steps: 16 });
      await expect.poll(() => page.evaluate('scrollY'), { timeout: 5_000 }).toBeGreaterThan(before);
      before = (await page.evaluate('scrollY')) as number;
    }
    await expect.poll(() => page.evaluate('scrollY'), { timeout: 5_000 }).toBe(maxY);
    await new Promise((r) => setTimeout(r, 400));
    expect(await page.evaluate('window.clicks')).toEqual([]);
    // The Verify button is on screen now: a tap clicks it.
    const verify = await canvasPointFor(human, await centerOf(page, '#verify'), size);
    await human.touchscreen.tap(verify.x, verify.y);
    await expect.poll(() => page.evaluate('window.verified'), { timeout: 10_000 }).toBe(1);
    expect(await page.evaluate('window.clicks')).toEqual(['verify']);

    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await unstuck.close();
    await ctx.close();
  }, 90_000);
});


describe('native typing on a simulated phone', () => {
  const bridgeState = (human: any) =>
    human.evaluate(() => {
      const b = document.querySelector('[data-testid="keyboard-bridge"]') as HTMLInputElement;
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return {
        focused: document.activeElement === b,
        inputMode: b.inputMode,
        autocomplete: b.getAttribute('autocomplete'),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        look: { opacity: cs.opacity, appearance: cs.appearance, boxShadow: cs.boxShadow },
      };
    });
  /** Taps an agent-page element on the phone until the bridge has focus (the field map arrives with the first frames). */
  async function tapToType(human: any, page: any, selector: string) {
    const at = await canvasPointFor(human, await centerOf(page, selector));
    await expect
      .poll(async () => {
        await human.touchscreen.tap(at.x, at.y);
        return (await bridgeState(human)).focused;
      }, { timeout: 15_000 })
      .toBe(true);
    return at;
  }

  it('a tap opens the number pad over the code field; whole codes, held Backspace, Shift, Tab and Return reach the page; a covered field does not open the keyboard', async () => {
    const { page, unstuck, result, link } = await startTakeover({ path: '/otp' });
    const { ctx, human } = await openHuman(link.url);
    await waitFramed(human, 15_000);

    // The single code field: the number pad with the SMS code suggestion, the bridge over the field.
    const at = await tapToType(human, page, '#single');
    const s1 = await bridgeState(human);
    expect([s1.inputMode, s1.autocomplete]).toEqual(['numeric', 'one-time-code']);
    // Never visible: some browsers (Samsung Internet) paint a faint box on a focused transparent input.
    expect(s1.look).toEqual({ opacity: '0', appearance: 'none', boxShadow: 'none' });
    expect(at.x).toBeGreaterThanOrEqual(s1.rect.x);
    expect(at.x).toBeLessThanOrEqual(s1.rect.x + s1.rect.w);
    expect(at.y).toBeGreaterThanOrEqual(s1.rect.y);
    expect(at.y).toBeLessThanOrEqual(s1.rect.y + s1.rect.h);
    // A code arriving in one piece (the SMS suggestion) lands whole.
    await human.keyboard.insertText('482913');
    await expect.poll(() => page.inputValue('#single'), { timeout: 10_000 }).toBe('482913');
    // A held Backspace (repeating key presses) empties it.
    for (let i = 0; i < 7; i++) await human.keyboard.down('Backspace');
    await human.keyboard.up('Backspace');
    await expect.poll(() => page.inputValue('#single'), { timeout: 10_000 }).toBe('');
    // Return/Go submits the real form.
    await human.keyboard.insertText('48');
    await human.keyboard.press('Enter');
    await expect.poll(() => page.evaluate('window.submitted || 0'), { timeout: 10_000 }).toBe(1);

    // Six drawn boxes with one invisible input over them, and six one-digit boxes that move focus.
    await tapToType(human, page, '#overlay');
    await human.keyboard.insertText('482913');
    await expect.poll(() => page.inputValue('#overlay'), { timeout: 10_000 }).toBe('482913');
    await tapToType(human, page, '#split input:first-child');
    // The green outline marks the box being typed into, and moves when the page moves focus to the next box.
    const ringX = () => human.evaluate(() => document.querySelector('[data-testid="focus-ring"]')?.getBoundingClientRect().x ?? null);
    const firstX = await ringX();
    expect(firstX).not.toBeNull();
    await human.keyboard.type('4');
    await expect.poll(ringX, { timeout: 10_000 }).toBeGreaterThan(firstX);
    await page.evaluate("document.querySelectorAll('#split input').forEach((el) => (el.value = ''))");
    await tapToType(human, page, '#split input:first-child');
    await human.keyboard.insertText('482913');
    await expect.poll(() => page.evaluate('window.splitValue()'), { timeout: 10_000 }).toBe('482913');
    // A mistake in six one-digit boxes: Backspace in an empty box jumps back and erases, as real widgets do.
    await page.evaluate("document.querySelectorAll('#split input').forEach((el) => (el.value = ''))");
    await tapToType(human, page, '#split input:first-child');
    await human.keyboard.type('KRES');
    await expect.poll(() => page.evaluate('window.splitValue()'), { timeout: 10_000 }).toBe('KRES');
    await human.keyboard.press('Backspace');
    await human.keyboard.press('Backspace');
    await expect.poll(() => page.evaluate('window.splitValue()'), { timeout: 10_000 }).toBe('KR');

    // Shift+letter arrives as a real key press with Shift; Tab moves the page's focus and the keyboard stays open.
    await tapToType(human, page, '#email');
    expect((await bridgeState(human)).inputMode).toBe('email');
    await human.keyboard.press('Shift+A');
    await expect.poll(() => page.inputValue('#email'), { timeout: 10_000 }).toBe('A');
    expect(await page.evaluate("window.keyEvents.some((e) => e.key === 'A' && e.shiftKey && e.target === 'email')")).toBe(true);
    await human.keyboard.press('Tab');
    await expect.poll(() => page.evaluate('document.activeElement.id'), { timeout: 10_000 }).toBe('next');
    expect((await bridgeState(human)).focused).toBe(true);

    // A tap on the cookie banner over a field doesn't open the keyboard (and closes the open one).
    const covered = await canvasPointFor(human, await centerOf(page, '#covered'));
    await human.touchscreen.tap(covered.x, covered.y);
    await expect.poll(async () => (await bridgeState(human)).focused, { timeout: 5_000 }).toBe(false);

    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await ctx.close();
    await unstuck.close();
    await page.close();
  }, 120_000);
});
