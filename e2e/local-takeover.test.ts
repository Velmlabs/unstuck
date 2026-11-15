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
  '/otp': fs.readFileSync(path.join(here, 'fixtures/otp.html')),
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

async function startTakeover(opts: { timeoutS?: number; path?: string; reason?: string } = {}) {
  const page = await agentBrowser.newPage({ viewport: { width: 1280, height: 720 } });
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

  it('page lock: a tap on a link to another site never leaves the agent\'s browser; same-site links still work', async () => {
    const { page, unstuck, result, link } = await startTakeover({ path: '/links' });
    const { ctx, human } = await openHuman(link.url);
    await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width! > 100, null, { timeout: 20_000 });
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
    for (const el of [human.getByRole('button', { name: 'Done' }), human.getByTestId('countdown')]) {
      const box = (await el.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await ctx.close();
    await unstuck.close();
    await page.close();
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


describe('native typing on a simulated phone', () => {
  const bridgeState = (human: any) =>
    human.evaluate(() => {
      const b = document.querySelector('[data-testid="keyboard-bridge"]') as HTMLInputElement;
      const r = b.getBoundingClientRect();
      return { focused: document.activeElement === b, inputMode: b.inputMode, autocomplete: b.getAttribute('autocomplete'), rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
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
    await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width! > 100, null, { timeout: 15_000 });

    // The single code field: the number pad with the SMS code suggestion, the bridge over the field.
    const at = await tapToType(human, page, '#single');
    const s1 = await bridgeState(human);
    expect([s1.inputMode, s1.autocomplete]).toEqual(['numeric', 'one-time-code']);
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
