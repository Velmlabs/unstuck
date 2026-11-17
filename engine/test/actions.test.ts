import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startChromium, type DebugChromium } from './chromium';
import { connectCdp, type DirectCdp } from '../src/direct-cdp';
import { takeSnapshot, type Snapshot } from '../src/browser/snapshot';
import { clickRef, PasswordFieldError, RefError, screenshotViewport, scrollPage, selectRef, typeRef, waitForTarget } from '../src/browser/actions';

const FORM = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'actions', 'form.html'), 'utf8');
let chrome: DebugChromium;
let server: http.Server;
let base = '';
let tab: DirectCdp;
const queries: string[] = [];

const evaluate = async <T>(expression: string): Promise<T> => (await tab.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true })).result.value;
const ref = (snap: Snapshot, line: RegExp) => {
  const m = snap.text.split('\n').find((l) => line.test(l));
  return /^\[(e\d+)\]/.exec(m ?? '')![1]!;
};
async function load(p: string) {
  await tab.send('Page.enable');
  const loaded = new Promise<void>((r) => {
    const off = tab.on('Page.loadEventFired', () => (off(), r()));
  });
  await tab.send('Page.navigate', { url: base + p });
  await loaded;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/done')) {
      queries.push(req.url);
      return void res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Done</title><p>Thanks</p>');
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(FORM);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  chrome = await startChromium();
  tab = await connectCdp(`http://127.0.0.1:${chrome.port}`);
}, 30_000);
afterAll(async () => {
  await tab?.close();
  await chrome?.stop();
  await new Promise((r) => server.close(r));
});

describe('actions', { timeout: 20_000 }, () => {
  it('click, type with submit, and select drive the real page', async () => {
    await load('/form');
    let snap = await takeSnapshot(tab);
    await clickRef(tab, snap, ref(snap, /button "Count"/));
    expect(await evaluate('window.clicks')).toBe(1);
    await selectRef(tab, snap, ref(snap, /combobox "Size"/), 'Large');
    expect(await evaluate('document.title')).toBe('size l');
    await selectRef(tab, snap, ref(snap, /combobox "Size"/), 'm');
    expect(await evaluate("document.getElementById('size').value")).toBe('m');
    await expect(selectRef(tab, snap, ref(snap, /combobox "Size"/), 'XXL')).rejects.toThrow(/^no option "XXL" in e\d+$/);
    await clickRef(tab, snap, ref(snap, /checkbox "Gift wrap"/));
    expect(await evaluate("document.getElementById('gift').checked")).toBe(true);
    snap = await takeSnapshot(tab);
    expect(snap.text).toMatch(/checkbox "Gift wrap" checked=true/);
    const name = ref(snap, /textbox "Name"/);
    await typeRef(tab, snap, name, 'first');
    await typeRef(tab, snap, name, 'Ana');
    expect(await evaluate("document.getElementById('name').value")).toBe('Ana');
    const nav = new Promise<void>((r) => {
      const off = tab.on('Page.loadEventFired', () => (off(), r()));
    });
    await typeRef(tab, snap, name, 'Ana B', true);
    await nav;
    expect(queries.at(-1)).toContain('name=Ana+B');
    expect(queries.at(-1)).toContain('size=m');
  });

  it('type into a password field is refused', async () => {
    await load('/form');
    const snap = await takeSnapshot(tab);
    const pw = ref(snap, /textbox "Secret"/);
    const err = await typeRef(tab, snap, pw, 'hunter2').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PasswordFieldError);
    expect((err as Error).message).toBe(`${pw} is a password field: call ask_human so the person types it`);
    expect(await evaluate("document.getElementById('pw').value")).toBe('');
  });

  it('a stale ref after navigation is a RefError, and so is an unknown one', async () => {
    await load('/form');
    const snap = await takeSnapshot(tab);
    await expect(clickRef(tab, snap, 'e999')).rejects.toBeInstanceOf(RefError);
    await load('/form');
    const err = await clickRef(tab, snap, ref(snap, /button "Count"/)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefError);
    expect((err as Error).message).toMatch(/^ref e\d+ is not on the page any more: take a new snapshot$/);
  });

  it('scroll, wait_for and screenshot', async () => {
    await load('/form');
    await scrollPage(tab, 'down');
    await new Promise((r) => setTimeout(r, 300));
    expect(await evaluate<number>('scrollY')).toBeGreaterThan(100);
    await scrollPage(tab, 'bottom');
    const bottom = await evaluate<number>('scrollY');
    await scrollPage(tab, 'up');
    await new Promise((r) => setTimeout(r, 300));
    expect(await evaluate<number>('scrollY')).toBeLessThan(bottom);
    await scrollPage(tab, 'top');
    expect(await evaluate<number>('scrollY')).toBe(0);
    expect(await waitForTarget(tab, { text: 'Ready now', timeoutS: 5 })).toBe(true);
    expect(await waitForTarget(tab, { text: 'Never there', timeoutS: 1 })).toBe(false);
    const snap = await takeSnapshot(tab);
    expect(await waitForTarget(tab, { ref: ref(snap, /button "Count"/), snap, timeoutS: 2 })).toBe(true);
    expect(await waitForTarget(tab, { ref: 'e999', snap, timeoutS: 1 })).toBe(false);
    const png = Buffer.from(await screenshotViewport(tab), 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
  });
});
