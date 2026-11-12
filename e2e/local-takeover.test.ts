import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Unstuck, type TakeoverLink } from 'unstuck';

const here = path.dirname(fileURLToPath(import.meta.url));
// Pre-installed Playwright (see sdk-ts/test/helpers.ts for why it is not a workspace dependency).
const { chromium, devices } = createRequire(import.meta.url)('playwright');
const ENGINE = path.resolve(here, '../engine/dist/unstuck-engine');
const FIXTURE = fs.readFileSync(path.join(here, 'fixtures/fake-captcha.html'));

let server: http.Server;
let site: string;
let agentBrowser: any;
let humanBrowser: any;

beforeAll(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(FIXTURE));
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

async function startTakeover(opts: { timeoutS?: number } = {}) {
  const page = await agentBrowser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(site);
  let link!: TakeoverLink;
  let linkArrived!: () => void;
  const gotLink = new Promise<void>((r) => (linkArrived = r));
  const unstuck = new Unstuck({ enginePath: ENGINE, onLink: (l) => ((link = l), linkArrived()) });
  const result = unstuck.takeover(page, { reason: 'Solve the test CAPTCHA', timeoutS: opts.timeoutS ?? 60 });
  await gotLink;
  return { page, unstuck, result, link };
}

async function openHuman(url: string) {
  const ctx = await humanBrowser.newContext({ ...devices['iPhone 13'] });
  const human = await ctx.newPage();
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
    expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{22}#t=/);

    const { ctx, human } = await openHuman(link.url);
    await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width! > 100, null, { timeout: 15_000 });
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
