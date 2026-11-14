import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import type { CdpClient } from '../src/cdp';
import { scanFields, focusedField } from '../src/stream/fields';

// A real Chromium page driven through real CDP, so the in-page scanner is tested where it runs.
// Minimal local types (as sdk-ts/test/helpers.ts does): playwright is a test-only tool here, not a dependency.
interface Page {
  setContent(html: string): Promise<void>;
  focus(selector: string): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  waitForFunction(fn: () => unknown): Promise<unknown>;
  context(): { newCDPSession(page: Page): Promise<{ send(method: string, params?: object): Promise<unknown> }> };
}
interface Browser {
  newPage(opts: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
}
const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as { chromium: { launch(): Promise<Browser> } };

let browser: Browser;
let page: Page;
let cdp: CdpClient;

beforeAll(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const session = await page.context().newCDPSession(page);
  cdp = {
    send: <T>(method: string, params?: object) => session.send(method, params) as Promise<T>,
    on: () => () => {},
    onClose: () => () => {},
  };
}, 60_000);
afterAll(() => browser?.close());

// border-box, so a field's measured box is exactly the size the fixture gives it.
const show = (body: string) => page.setContent(`<!doctype html><html><head><style>input,textarea{box-sizing:border-box}</style></head><body style="margin:0">${body}</body></html>`);

describe('scanFields (in a real page)', () => {
  it('classifies each kind of field', async () => {
    await show(`
      <input id=otp autocomplete="one-time-code" style="position:absolute;left:10px;top:10px;width:100px;height:30px">
      <input type=tel style="position:absolute;left:10px;top:50px;width:100px;height:30px">
      <input type=number style="position:absolute;left:10px;top:90px;width:100px;height:30px">
      <input inputmode=decimal style="position:absolute;left:10px;top:130px;width:100px;height:30px">
      <input type=email style="position:absolute;left:10px;top:170px;width:100px;height:30px">
      <input inputmode=email style="position:absolute;left:10px;top:210px;width:100px;height:30px">
      <input type=password style="position:absolute;left:10px;top:250px;width:100px;height:30px">
      <input style="position:absolute;left:10px;top:290px;width:100px;height:30px">
      <textarea style="position:absolute;left:10px;top:330px;width:100px;height:30px"></textarea>
      <div contenteditable style="position:absolute;left:10px;top:370px;width:100px;height:30px">x</div>`);
    const byTop = Object.fromEntries((await scanFields(cdp)).map((f) => [f.y, f.kind]));
    expect(byTop).toEqual({ 10: 'otp', 50: 'numeric', 90: 'numeric', 130: 'numeric', 170: 'email', 210: 'email', 250: 'password', 290: 'text', 330: 'text', 370: 'text' });
  });

  it('skips hidden, disabled, read-only, zero-size and off-screen fields', async () => {
    await show(`
      <input style="display:none">
      <input style="visibility:hidden;position:absolute;top:10px">
      <input disabled style="position:absolute;top:50px">
      <input readonly style="position:absolute;top:90px">
      <input style="position:absolute;top:130px;width:0;height:0;padding:0;border:0">
      <input style="position:absolute;top:2000px">
      <input id=ok style="position:absolute;left:5px;top:200px;width:80px;height:20px">`);
    expect(await scanFields(cdp)).toEqual([{ x: 5, y: 200, w: 80, h: 20, kind: 'text' }]);
  });

  it('keeps an invisible input stretched over drawn code boxes', async () => {
    await show(`
      <div style="position:absolute;left:20px;top:100px;width:300px;height:50px">
        <div style="display:flex;gap:4px">${'<span style="width:46px;height:50px;border:1px solid #ccc"></span>'.repeat(6)}</div>
        <input autocomplete="one-time-code" maxlength=6 style="position:absolute;inset:0;width:100%;height:100%;opacity:0">
      </div>`);
    expect(await scanFields(cdp)).toEqual([{ x: 20, y: 100, w: 300, h: 50, kind: 'otp' }]);
  });

  it('skips a field covered by a banner', async () => {
    await show(`
      <input style="position:absolute;left:10px;top:700px;width:200px;height:30px">
      <input type=email style="position:absolute;left:10px;top:100px;width:200px;height:30px">
      <div style="position:fixed;left:0;right:0;bottom:0;height:200px;background:#000">Cookies</div>`);
    expect((await scanFields(cdp)).map((f) => f.kind)).toEqual(['email']);
  });

  it('finds fields in a same-origin iframe (offset) and in an open shadow root', async () => {
    await show(`
      <iframe style="position:absolute;left:50px;top:300px;width:200px;height:100px;border:0" srcdoc="<body style='margin:0'><input type=tel style='box-sizing:border-box;position:absolute;left:10px;top:20px;width:80px;height:30px'></body>"></iframe>
      <div id=host style="position:absolute;left:0;top:0"></div>
      <script>
        const r = document.getElementById('host').attachShadow({ mode: 'open' });
        r.innerHTML = '<input type=email style="box-sizing:border-box;position:absolute;left:30px;top:40px;width:90px;height:20px">';
      </script>`);
    await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('input'));
    const fields = await scanFields(cdp);
    expect(fields).toContainEqual({ x: 60, y: 320, w: 80, h: 30, kind: 'numeric' });
    expect(fields).toContainEqual({ x: 30, y: 40, w: 90, h: 20, kind: 'email' });
  });

  it('returns at most 30 whole-pixel boxes, nearest the centre first, and never a value', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `<input value="secret${i}" style="position:absolute;left:10.4px;top:${i * 20 + 0.6}px;width:50px;height:15px">`).join('');
    await show(many);
    const fields = await scanFields(cdp);
    expect(fields).toHaveLength(30);
    for (const f of fields) {
      expect(Object.keys(f)).toEqual(['x', 'y', 'w', 'h', 'kind']);
      expect(Number.isInteger(f.x) && Number.isInteger(f.y) && Number.isInteger(f.w) && Number.isInteger(f.h)).toBe(true);
    }
    const centre = 844 / 2;
    const dist = fields.map((f) => Math.abs(f.y + f.h / 2 - centre));
    expect([...dist].sort((a, b) => a - b)).toEqual(dist);
    expect(JSON.stringify(fields)).not.toContain('secret');
  });
});

describe('focusedField (in a real page)', () => {
  it('reports the focused field with its box, null for none, and a focused cross-origin frame as a text field', async () => {
    await show(`<input id=e type=email style="position:absolute;left:10px;top:20px;width:200px;height:30px">
      <iframe id=x sandbox="allow-scripts" srcdoc="<input>" style="position:absolute;left:10px;top:100px;width:300px;height:80px;border:0"></iframe>
      <iframe id=same srcdoc="<body style='margin:0'><input id=in type=tel style='box-sizing:border-box;position:absolute;left:5px;top:6px;width:50px;height:20px'></body>" style="position:absolute;left:200px;top:300px;width:150px;height:100px;border:0"></iframe>`);
    await page.focus('#e');
    expect(await focusedField(cdp)).toEqual({ x: 10, y: 20, w: 200, h: 30, kind: 'email' });
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    expect(await focusedField(cdp)).toBe(null);
    await page.evaluate(() => document.getElementById('x')!.focus());
    expect(await focusedField(cdp)).toEqual({ x: 10, y: 100, w: 300, h: 80, kind: 'text' });
    await page.waitForFunction(() => (document.getElementById('same') as HTMLIFrameElement).contentDocument?.getElementById('in'));
    await page.focus('#e'); // focus back in the top page first: a cross-origin frame keeps focus from scripts
    await page.evaluate(() => ((document.getElementById('same') as HTMLIFrameElement).contentDocument!.getElementById('in') as HTMLElement).focus());
    expect(await focusedField(cdp)).toEqual({ x: 205, y: 306, w: 50, h: 20, kind: 'numeric' });
  });
});
