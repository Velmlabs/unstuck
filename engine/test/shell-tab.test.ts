import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { launchChrome } from '../src/browser/launcher';
import { connectBrowser } from '../src/direct-cdp';
import { resolveTab, ShellError } from '../src/shell/tab';

const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { executablePath(): string } };

let browser: Awaited<ReturnType<typeof launchChrome>>;
let http: string;
beforeAll(async () => {
  browser = await launchChrome({ path: chromium.executablePath(), isRoot: process.getuid?.() === 0 });
  http = browser.cdpUrl.replace(/^ws:\/\/([^/]+)\/.*$/, 'http://$1');
});
afterAll(async () => {
  await browser.stop();
});

const pages = async () => {
  const b = await connectBrowser(browser.cdpUrl);
  const { targetInfos } = await b.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
  await b.close();
  return targetInfos.filter((t) => t.type === 'page');
};
const openTab = async (url: string) => {
  const b = await connectBrowser(browser.cdpUrl);
  const { targetId } = await b.send<{ targetId: string }>('Target.createTarget', { url });
  await b.close();
  return targetId;
};
const closeTab = async (targetId: string) => {
  const b = await connectBrowser(browser.cdpUrl);
  await b.send('Target.closeTarget', { targetId });
  await b.close();
};
const err = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ShellError);

describe('resolveTab', () => {
  it('picks the only page tab (http, host:port and browser ws urls)', async () => {
    const [only] = await pages();
    for (const url of [http, http.replace('http://', ''), browser.cdpUrl]) {
      const t = await resolveTab(url);
      expect(t.targetId).toBe(only!.targetId);
      expect(t.browserWsUrl).toBe(browser.cdpUrl);
    }
  });

  it('with several tabs throws several_tabs listing targetId, url and title', async () => {
    const extra = await openTab('data:text/html,<title>Two</title>');
    try {
      const e = await err(resolveTab(http));
      expect(e).toBeInstanceOf(ShellError);
      expect(e!.code).toBe('several_tabs');
      const tabs = e!.extra!.tabs as { targetId: string; url: string; title: string }[];
      expect(tabs.map((t) => t.targetId)).toContain(extra);
      expect(Object.keys(tabs[0]!).sort()).toEqual(['targetId', 'title', 'url']);
      const picked = await resolveTab(http, extra);
      expect(picked.targetId).toBe(extra);
    } finally {
      await closeTab(extra);
    }
  });

  it('--tab unknown throws tab_not_found', async () => {
    expect((await err(resolveTab(http, 'NOPE')))!.code).toBe('tab_not_found');
  });

  it('page-level ws url selects that tab', async () => {
    const [only] = await pages();
    const pageWs = browser.cdpUrl.replace(/\/devtools\/browser\/.*/, `/devtools/page/${only!.targetId}`);
    const t = await resolveTab(pageWs);
    expect(t.targetId).toBe(only!.targetId);
    expect(t.browserWsUrl).toBe(browser.cdpUrl);
  });

  it('devtools:// and non-page targets are ignored; no page at all is no_tabs', async () => {
    const [only] = await pages();
    const e = await err(
      resolveTab(http, undefined, {
        list: async () => [
          { targetId: 'w', type: 'service_worker', url: 'https://x/sw.js', title: '' },
          { targetId: 'd', type: 'page', url: 'devtools://devtools/x', title: 'DevTools' },
        ],
      }),
    );
    expect(e!.code).toBe('no_tabs');
    expect(only).toBeDefined();
  });

  it('a browser that cannot be reached is unreachable', async () => {
    expect((await err(resolveTab('http://127.0.0.1:1')))!.code).toBe('unreachable');
  });
});
