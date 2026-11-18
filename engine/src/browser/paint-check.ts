// Does this browser draw cross-origin iframes? (CAPTCHA widgets live in them.) Moved from the doctor so Unstuck Browser
// can ask the same question before it opens a takeover a person couldn't finish.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import type { CdpClient } from '@velmlabs/unstuck-core';

const LOAD_WAIT_MS = 5000;
/** Each step after the load (the box, the screenshot): a background tab that never paints must not hang the check. */
const STEP_WAIT_MS = 10_000;

/** `p`, or a rejection after `ms`. */
const inTime = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('paint check step timed out')), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e: unknown) => (clearTimeout(t), reject(e)));
  });

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

/** The probe: a white parent on 127.0.0.1 holding a solid green child page from localhost. */
export async function serveProbePages(): Promise<{ url: string; close(): Promise<void> }> {
  const child = await serve('localhost', () => '<!doctype html><body style="margin:0;background:#00ff00"></body>');
  const parent = await serve(
    '127.0.0.1',
    () =>
      `<!doctype html><body style="margin:0;background:#fff"><iframe id="child" src="http://localhost:${child.port}/" style="border:0;width:300px;height:200px;margin:40px" onload="window.__childLoaded=true"></iframe></body>`,
  );
  return {
    url: `http://127.0.0.1:${parent.port}/`,
    close: async () => {
      await parent.close();
      await child.close();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `check` every 100 ms until it holds or `ms` has passed. */
export async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
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

/** In a tab showing the probe pages: is the child's green actually painted? */
export async function checkIframePaint(tab: CdpClient, loadWaitMs = LOAD_WAIT_MS, stepWaitMs = STEP_WAIT_MS): Promise<boolean | 'unknown'> {
  const loaded = await waitFor(() => evaluate<boolean>(tab, 'window.__childLoaded === true'), loadWaitMs);
  if (!loaded) return 'unknown';
  await sleep(300);
  const box = await inTime(
    evaluate<{ x: number; y: number; dpr: number }>(
      tab,
      "(() => { const r = document.getElementById('child').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: devicePixelRatio }; })()",
    ),
    stepWaitMs,
  );
  const shot = await inTime(tab.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }), stepWaitMs);
  const png = PNG.sync.read(Buffer.from(shot.data, 'base64'));
  const px = Math.min(png.width - 1, Math.round(box.x * box.dpr));
  const py = Math.min(png.height - 1, Math.round(box.y * box.dpr));
  const i = (png.width * py + px) * 4;
  const [r, g, b] = [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
  return g > 200 && r < 80 && b < 80;
}

/** Serves the probe, opens it in a tab of its own and checks it. Any error is 'unknown'; the tab and servers always close. */
export async function probeCaptchaPaint(
  openTab: (url: string) => Promise<{ cdp: CdpClient; close(): Promise<void> }>,
  o: { loadWaitMs?: number; stepWaitMs?: number } = {},
): Promise<boolean | 'unknown'> {
  let pages: Awaited<ReturnType<typeof serveProbePages>> | undefined;
  let tab: { cdp: CdpClient; close(): Promise<void> } | undefined;
  try {
    pages = await serveProbePages();
    tab = await openTab(pages.url);
    return await checkIframePaint(tab.cdp, o.loadWaitMs, o.stepWaitMs);
  } catch {
    return 'unknown';
  } finally {
    await tab?.close().catch(() => {});
    await pages?.close().catch(() => {});
  }
}
