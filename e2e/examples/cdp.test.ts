import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { actAsHuman, assertShownFile, CHROMIUM, chromium, chromiumNoSandbox, example, exampleEnv, REPO, runExample, startSite } from './harness';

const freePort = () =>
  new Promise<number>((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => r(port));
    });
  });

/** A Chrome someone else started (a hosted browser, a teammate's agent): debugging port open, several tabs. */
async function startChrome(urls: string[]): Promise<{ cdpUrl: string; tabs: () => Promise<{ url: string; type: string }[]>; stop: () => void }> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-'));
  const proc: ChildProcess = spawn(CHROMIUM, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--window-size=1280,720', urls[0]!], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  proc.stderr!.on('data', (d: Buffer) => (errors += d.toString()));
  proc.on('exit', (code) => (errors += `\n[chrome exited ${code}]`));
  const cdpUrl = `http://127.0.0.1:${port}`;
  const tabs = async () => ((await (await fetch(`${cdpUrl}/json/list`)).json()) as { url: string; type: string }[]).filter((t) => t.type === 'page');
  for (let i = 0; i < 100; i++) {
    try {
      if ((await tabs()).length >= 1) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  // Headless Chrome takes one start URL; open the other tabs through its debugging endpoint, in order.
  for (const u of urls.slice(1)) await fetch(`${cdpUrl}/json/new?${encodeURIComponent(u)}`, { method: 'PUT' });
  for (let i = 0; i < 50 && (await tabs()).filter((t) => t.url !== 'about:blank').length < urls.filter((u) => u !== 'about:blank').length; i++) await new Promise((r) => setTimeout(r, 100));
  if (process.env.DEBUG_CHROME) console.log('CHROME', cdpUrl, errors.split('\n').filter((l) => !/dbus/.test(l)).join('\n').slice(-1500));
  return { cdpUrl, tabs, stop: () => proc.kill() };
}

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => (site = await startSite()));
afterAll(() => site?.close());

describe('any browser over CDP', () => {
  it("Review Focus 5: attaches to a running browser and takes over the agent's tab, leaving the browser running", async () => {
    const chrome = await startChrome(['about:blank', `${site.url}captcha`, `${site.url}other`]);
    try {
      const run = await runExample('pnpm', ['start'], { cwd: example('cdp'), env: exampleEnv({ CDP_URL: chrome.cdpUrl, AGENT_URL_PART: '/captcha' }) });
      await actAsHuman(run.link, 'done');
      const r = await run.finish();
      expect(r.status, r.stdout).toBe('resolved');
      expect(r.stdout).toContain('/captcha');
      expect((await chrome.tabs()).length).toBe(3);
    } finally {
      chrome.stop();
    }
  });

  it('agentPage matches by URL, falls back to a real (non-blank) tab, and throws on an empty browser', async () => {
    const { agentPage } = await import(path.join(REPO, 'examples/cdp/agent-page.ts'));
    const chrome = await startChrome(['about:blank', `${site.url}other`, `${site.url}captcha`]);
    const browser = await chromium.connectOverCDP(chrome.cdpUrl);
    try {
      expect((await agentPage(browser, '/captcha')).url()).toContain('/captcha');
      expect((await agentPage(browser, '/other')).url()).toContain('/other');
      for (const part of ['/nowhere', undefined]) expect((await agentPage(browser, part)).url()).not.toBe('about:blank');
    } finally {
      chrome.stop();
    }
    const blank = await startChrome(['about:blank']);
    const b2 = await chromium.connectOverCDP(blank.cdpUrl);
    try {
      await expect(agentPage(b2)).rejects.toThrow('no page to take over');
    } finally {
      blank.stop();
    }
  });

  /** A chromedriver whose major version matches the Chromium we have (Chrome refuses any other). */
  const chromedriver = (() => {
    try {
      const driver = process.env.CHROMEDRIVER ?? execFileSync('which', ['chromedriver']).toString().trim();
      const major = (s: string) => /(\d+)\./.exec(s)?.[1];
      const ok = major(execFileSync(driver, ['--version']).toString()) === major(execFileSync(CHROMIUM, ['--version']).toString());
      return ok ? driver : '';
    } catch {
      return '';
    }
  })();
  it.skipIf(!chromedriver)('selenium: Chrome started by Selenium, Unstuck attaches over CDP (skipped without a chromedriver matching this Chromium; this sandbox cannot download one)', async () => {
    const run = await runExample('uv', ['run', '--project', path.join(REPO, 'sdk-py'), '--with-requirements', 'requirements.txt', 'python', 'main.py', `${site.url}captcha`], {
      cwd: example('selenium'),
      env: exampleEnv({ SE_DRIVER_PATH: chromedriver, SE_BROWSER_PATH: chromiumNoSandbox() }),
    });
    await actAsHuman(run.link, 'done');
    expect((await run.finish()).status).toBe('resolved');
  });

  it('shown files use final names only, and the Selenium example at least compiles', () => {
    for (const f of ['cdp/index.ts', 'cdp/agent-page.ts', 'selenium/main.py']) assertShownFile(example(f));
    execFileSync('python3', ['-m', 'py_compile', example('selenium/main.py')]);
  });
});
