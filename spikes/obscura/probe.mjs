// Throwaway spike (Plan 1, Task 1): probe the CDP capabilities Unstuck needs.
// Usage: node spikes/obscura/probe.mjs obscura|chromium <out-dir>
// obscura: expects `obscura serve --port 9222` on 127.0.0.1.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const mode = process.argv[2] ?? 'obscura';
const outDir = process.argv[3] ?? '.';
fs.mkdirSync(outDir, { recursive: true });

const FIXTURE = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<button id="b" style="position:absolute;left:100px;top:100px;width:200px;height:60px">Click me</button>
<input id="i" style="position:absolute;left:100px;top:200px;width:300px;height:30px">
<script>window.clicks=0;document.getElementById('b').onclick=()=>{window.clicks++}</script>
</body></html>`;
const IFRAME = `<!doctype html><html><body><h1>outer</h1><iframe id="f" src="https://www.iana.org/help/example-domains" width="600" height="300"></iframe></body></html>`;
const POPUP = `<!doctype html><html><body><button id="p" onclick="window.open('https://example.com/?popup=1','_blank')">open</button></body></html>`;
// The sandbox proxy only tunnels HTTPS, and Obscura has no proxy bypass, so fixtures are
// injected into a real HTTPS origin instead of being served from 127.0.0.1.
async function load(p, html) {
  await p.goto('https://example.com/', { waitUntil: 'load' });
  await p.setContent(html, { waitUntil: 'load' });
}
const TURNSTILE = `<!doctype html><html><head><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script></head>
<body><form><div class="cf-turnstile" data-sitekey="1x00000000000000000000AA"></div></form></body></html>`;

const server = http.createServer((req, res) => {
  const body = { '/fixture': FIXTURE, '/iframe': IFRAME, '/popup': POPUP, '/turnstile': TURNSTILE }[req.url];
  res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
  res.end(body ?? 'nf');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = {};
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))]);
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await withTimeout(fn(), 20000, name);
    results[name] = { ok: true, ms: Date.now() - t0, detail };
  } catch (e) {
    results[name] = { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 300) };
  }
  console.error(`${results[name].ok ? 'PASS' : 'FAIL'} ${name}`, JSON.stringify(results[name]).slice(0, 200));
}

const browser =
  mode === 'obscura'
    ? await chromium.connectOverCDP('ws://127.0.0.1:9222/devtools/browser')
    : await chromium.launch({ proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1' } : undefined });
const context = browser.contexts()[0] ?? (await browser.newContext({ viewport: { width: 1280, height: 720 } }));
const page = await context.newPage();
await page.setViewportSize({ width: 1280, height: 720 }).catch(() => {});
const cdp = await context.newCDPSession(page);

await check('navigate', async () => {
  await load(page, FIXTURE);
  return { url: page.url(), clicksDefined: await page.evaluate('typeof window.clicks') };
});

await check('Runtime.evaluate', async () => {
  const r = await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
  if (r.result.value !== 2) throw new Error(`got ${JSON.stringify(r.result)}`);
  return r.result.value;
});

await check('Page.startScreencast', async () => {
  const frames = [];
  const handler = async (f) => {
    frames.push({ bytes: f.data.length, meta: f.metadata });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  };
  cdp.on('Page.screencastFrame', handler);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1600 });
  // Nudge activity so activity-driven screencasts emit.
  await cdp.send('Runtime.evaluate', { expression: "document.body.style.background='#eef'" });
  const t0 = Date.now();
  while (frames.length === 0 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 100));
  await cdp.send('Runtime.evaluate', { expression: "document.body.style.background='#fee'" });
  await new Promise((r) => setTimeout(r, 1500));
  await cdp.send('Page.stopScreencast');
  cdp.off('Page.screencastFrame', handler);
  if (frames.length === 0) throw new Error('no frames within 5 s');
  return { frames: frames.length, first: frames[0] };
});

await check('Page.captureScreenshot', async () => {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, `${mode}-fixture.png`), Buffer.from(r.data, 'base64'));
  return { bytes: r.data.length };
});

await check('Input.dispatchMouseEvent (click)', async () => {
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp.send('Input.dispatchMouseEvent', { type, x: 200, y: 130, button: 'left', clickCount: 1 });
  const clicks = await page.evaluate('window.clicks');
  if (clicks !== 1) throw new Error(`clicks=${clicks}`);
  return clicks;
});

await check('Input.dispatchKeyEvent (type "a")', async () => {
  await page.evaluate("document.getElementById('i').focus()");
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', unmodifiedText: 'a' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
  const v = await page.evaluate("document.getElementById('i').value");
  if (v !== 'a') throw new Error(`value=${JSON.stringify(v)}`);
  return v;
});

await check('Input.insertText (unicode)', async () => {
  await cdp.send('Input.insertText', { text: 'héllo 日本' });
  const v = await page.evaluate("document.getElementById('i').value");
  if (v !== 'ahéllo 日本') throw new Error(`value=${JSON.stringify(v)}`);
  return v;
});

await check('cross-origin iframe (OOPIF) attach', async () => {
  const attached = [];
  cdp.on('Target.attachedToTarget', (e) => attached.push(e.targetInfo));
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await load(page, IFRAME);
  await page.waitForTimeout(3000);
  const frames = page.frames().map((f) => f.url());
  const iframeTargets = attached.filter((t) => t.type === 'iframe').map((t) => t.url);
  const childReachable = await page
    .frameLocator('#f')
    .locator('body')
    .innerText({ timeout: 5000 })
    .then((t) => t.slice(0, 60))
    .catch((e) => `ERR ${String(e.message).slice(0, 80)}`);
  return { playwrightFrames: frames, oopifTargets: iframeTargets, childH1: childReachable };
});

await check('popup tracking (window.open)', async () => {
  await load(page, POPUP);
  const popupP = context.waitForEvent('page', { timeout: 8000 });
  popupP.catch(() => {});
  await page.click('#p');
  const popup = await popupP;
  await popup.waitForLoadState().catch(() => {});
  return { popupUrl: popup.url() };
});

for (const [name, url, file] of [
  ['recaptcha demo render', 'https://www.google.com/recaptcha/api2/demo', 'recaptcha'],
  ['hcaptcha demo render', 'https://accounts.hcaptcha.com/demo', 'hcaptcha'],
  ['turnstile test-key render', `${base}/turnstile`, 'turnstile'],
]) {
  await check(name, async () => {
    const p = await context.newPage();
    await p.setViewportSize({ width: 1280, height: 720 }).catch(() => {});
    if (file === 'turnstile') await load(p, TURNSTILE);
    else await p.goto(url, { waitUntil: 'load', timeout: 15000 });
    await p.waitForTimeout(5000);
    const s = await context.newCDPSession(p);
    const r = await s.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(outDir, `${mode}-${file}.png`), Buffer.from(r.data, 'base64'));
    const iframes = await p.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => f.src.slice(0, 80)));
    const frames = p.frames().map((f) => f.url().slice(0, 60));
    await p.close().catch(() => {});
    return { iframes, frames };
  });
}

fs.writeFileSync(path.join(outDir, `${mode}-results.json`), JSON.stringify(results, null, 2));
await browser.close().catch(() => {});
server.close();
process.exit(0);
