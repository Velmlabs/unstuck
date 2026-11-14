import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import { probeCapabilities, type Capabilities, type CdpClient } from '@velmlabs/unstuck-core';
import { connectCdp, type DirectCdp } from './direct-cdp';

export interface DoctorReport {
  browser: string;
  capabilities: Capabilities;
  crossOriginIframePaint: boolean | 'unknown';
  popupTracking: boolean | 'unknown';
  verdict: 'full' | 'limited' | 'unsupported';
  notes: string[];
}

const LIMITED_NOTE = 'CAPTCHA widgets in cross-origin iframes will not be visible; use Chromium for CAPTCHAs';
const POPUP_WAIT_MS = 3000;
const LOAD_WAIT_MS = 5000;

/** Serves one HTML page on 127.0.0.1 or localhost (different sites → a real cross-origin iframe). */
export async function serve(host: string, html: (port: number) => string): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html((server.address() as AddressInfo).port));
  });
  await new Promise<void>((r) => server.listen(0, host, r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections(); // don't wait for a browser still mid-request
      }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

async function evaluate<T>(cdp: CdpClient, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
}

async function checkIframePaint(tab: CdpClient): Promise<boolean | 'unknown'> {
  const loaded = await waitFor(() => evaluate<boolean>(tab, 'window.__childLoaded === true'), LOAD_WAIT_MS);
  if (!loaded) return 'unknown';
  await sleep(300);
  const box = await evaluate<{ x: number; y: number; dpr: number }>(
    tab,
    "(() => { const r = document.getElementById('child').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio }; })()",
  );
  const shot = await tab.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  const png = PNG.sync.read(Buffer.from(shot.data, 'base64'));
  const px = Math.min(png.width - 1, Math.round(box.x * box.dpr));
  const py = Math.min(png.height - 1, Math.round(box.y * box.dpr));
  const i = (png.width * py + px) * 4;
  const [r, g, b] = [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
  return g > 200 && r < 80 && b < 80;
}

async function checkPopups(tab: DirectCdp): Promise<{ seen: boolean; ids: string[] }> {
  const ids: string[] = [];
  let seen = false;
  const offCreated = tab.browser.on('Target.targetCreated', (e: { targetInfo: { targetId: string; openerId?: string } }) => {
    if (e.targetInfo.openerId === tab.targetId) ids.push(e.targetInfo.targetId);
  });
  const offPopup = tab.popups.onPopup(() => (seen = true));
  await tab.send('Runtime.evaluate', { expression: "window.open('about:blank#unstuck-doctor', '_blank')", userGesture: true }).catch(() => {});
  await waitFor(async () => seen, POPUP_WAIT_MS);
  offPopup();
  offCreated();
  return { seen, ids };
}

/** Checks a browser end to end in a tab of its own; never touches the user's tabs (spec §4.4). */
export async function runDoctor(cdpUrl: string, opts: { connect?: typeof connectCdp } = {}): Promise<DoctorReport> {
  const connect = opts.connect ?? connectCdp;
  const child = await serve('localhost', () => '<!doctype html><body style="margin:0;background:#00ff00"></body>');
  const parent = await serve(
    '127.0.0.1',
    () =>
      `<!doctype html><body style="margin:0;background:#fff"><iframe id="child" src="http://localhost:${child.port}/" style="border:0;width:300px;height:200px;margin:40px" onload="window.__childLoaded=true"></iframe></body>`,
  );
  let tab: DirectCdp | undefined;
  const opened: string[] = [];
  try {
    // One connection for everything: works on browsers with no tabs and on ones that scope tabs per connection.
    tab = await connect(cdpUrl, { createUrl: `http://127.0.0.1:${parent.port}/` });
    opened.push(tab.targetId);
    const browser = await tab.browser
      .send<{ product: string }>('Browser.getVersion')
      .then((v) => v.product)
      .catch(() => 'unknown browser');
    const capabilities = await probeCapabilities(tab);
    const crossOriginIframePaint = await checkIframePaint(tab).catch(() => 'unknown' as const);
    const popups = await checkPopups(tab);
    opened.push(...popups.ids);
    const notes: string[] = [];
    if (!capabilities.screencast) notes.push('no screencast: Unstuck will poll screenshots (about 5 fps)');
    if (!capabilities.insertText) notes.push('no insertText: Unstuck will type text key by key');
    if (crossOriginIframePaint === false) notes.push(LIMITED_NOTE);
    if (crossOriginIframePaint === 'unknown')
      notes.push('could not load the test page from the browser (it may not reach this machine): CAPTCHA support was not checked');
    if (!popups.seen) notes.push('popups are not reported: a CAPTCHA that opens a window cannot be followed');
    // FULL only when CAPTCHA rendering was actually verified.
    const verdict = !capabilities.input ? 'unsupported' : crossOriginIframePaint === true ? 'full' : 'limited';
    return { browser, capabilities, crossOriginIframePaint, popupTracking: popups.seen, verdict, notes };
  } finally {
    if (tab) {
      for (const id of opened.reverse()) await tab.browser.send('Target.closeTarget', { targetId: id }).catch(() => {});
      await tab.close();
    }
    await parent.close();
    await child.close();
  }
}

const mark = (v: boolean | 'unknown') => (v === 'unknown' ? '?' : v ? '✓' : '✗');

export function formatReport(r: DoctorReport): string {
  return [
    `Browser: ${r.browser}`,
    `${mark(r.capabilities.screencast)} live view (screencast)`,
    `${mark(r.capabilities.insertText)} paste (insertText)`,
    `${mark(r.capabilities.input)} mouse and keyboard input`,
    `${mark(r.crossOriginIframePaint)} cross-origin iframes painted (CAPTCHA widgets)`,
    `${mark(r.popupTracking)} popups reported`,
    `Verdict: ${r.verdict.toUpperCase()}`,
    ...r.notes.map((n) => `  - ${n}`),
    '',
  ].join('\n');
}
