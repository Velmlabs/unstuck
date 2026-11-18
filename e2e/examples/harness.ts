// Runs an example as a user would, catches its takeover link, and plays the human on an iPhone-sized browser.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net, { type AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** The start page's button: Start takeover, Answer (a question) or Open (an approval). */
const START = /^(Start takeover|Answer|Open)$/;
/** Taps Start on a takeover link (the page connects only then; a reload by the same phone goes straight back in). */
async function tapStart(p: { getByRole: (role: 'button', o: { name: string | RegExp }) => { isVisible: () => Promise<boolean>; click: () => Promise<void> } }) {
  const b = p.getByRole('button', { name: START });
  if (await b.isVisible()) await b.click();
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '../..');
export const ENGINE = path.join(REPO, 'engine/dist/unstuck-engine');
export const example = (name: string) => path.join(REPO, 'examples', name);
/** Pre-installed Playwright (not a workspace dependency, see sdk-ts/test/helpers.ts). */
export const { chromium, devices } = createRequire(import.meta.url)('playwright');
/** The pre-installed Chromium, for libraries that would otherwise download their own (Puppeteer, Selenium). */
export const CHROMIUM: string = (() => {
  const root = '/opt/pw-browsers';
  const dir = fs.existsSync(root) ? fs.readdirSync(root).find((d) => /^chromium-\d+$/.test(d)) : undefined;
  const bin = dir && ['chrome-linux64/chrome', 'chrome-linux/chrome'].map((p) => path.join(root, dir, p)).find((p) => fs.existsSync(p));
  return process.env.CHROMIUM_PATH ?? bin ?? chromium.executablePath();
})();

/** CHROMIUM plus --no-sandbox (needed when tests run as root), so the examples themselves stay free of container flags. */
export function chromiumNoSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-'));
  const wrapper = path.join(dir, 'chrome');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${CHROMIUM}" --no-sandbox "$@"\n`, { mode: 0o755 });
  return wrapper;
}

/** The repo's engine stands in for the published package; shown files never mention it. */
export const exampleEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ UNSTUCK_ENGINE_PATH: ENGINE, ...extra });

/** Local pages for the agent to get stuck on: / and /captcha (fake CAPTCHA), /other. */
export async function startSite(): Promise<{ url: string; close: () => void }> {
  const captcha = fs.readFileSync(path.join(here, '../fixtures/fake-captcha.html'));
  const pages: Record<string, Buffer> = { '/': captcha, '/captcha': captcha, '/other': Buffer.from('<!doctype html><title>Other</title><p>Another tab</p>') };
  const server = http.createServer((req, res) => {
    const body = pages[new URL(req.url ?? '/', 'http://x').pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }).end(body ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => server.close() };
}

export interface RunningExample {
  link: string;
  finish: () => Promise<{ status: string; stdout: string; code: number | null }>;
}

/** Spawns an example; resolves once it printed its link (the line after "Open this link:"). */
export function runExample(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string>; timeoutMs?: number }): Promise<RunningExample> {
  const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  const finish = async () => {
    const code = await exited;
    return { status: /Takeover (\w+)/.exec(out)?.[1] ?? 'none', stdout: out, code };
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no takeover link within ${opts.timeoutMs ?? 120_000} ms. Output:\n${out}`));
    }, opts.timeoutMs ?? 120_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = /Open this link:\s*\n\s*(\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ link: m[1]!, finish });
      }
    };
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`example exited (${code}) before printing a link. Output:\n${out}`));
    });
  });
}

/** Opens the link on an iPhone 13, waits for the live screen, and taps Done or Can't solve. */
export async function actAsHuman(link: string, action: 'done' | 'cant-solve'): Promise<void> {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const human = await ctx.newPage();
    await human.goto(link);
    await tapStart(human);
    await human.waitForFunction(() => ((document.querySelector('canvas') as HTMLCanvasElement | null)?.width ?? 0) > 300, null, { timeout: 60_000 });
    await human.getByRole('button', { name: action === 'done' ? 'Done' : "Can't solve" }).click();
    await human.waitForTimeout(500);
  } finally {
    await browser.close();
  }
}

/** The example's requirements.txt minus `unstuck` (not on PyPI yet: the local sdk-py project provides it). */
export function requirementsWithoutUnstuck(file: string): string {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'req-')), 'requirements.txt');
  fs.writeFileSync(out, fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== 'unstuck').join('\n'));
  return out;
}

/** Fails on anything a user must never see in an example: repo-only wiring, old names, keys. */
export function assertShownFile(file: string): void {
  const text = fs.readFileSync(file, 'utf8');
  for (const bad of ['UNSTUCK_ENGINE_PATH', 'workspace:', "from 'unstuck'", 'from "unstuck"', '@unstuck/', '../../engine', '--project ../../sdk-py', 'Open this on any device']) {
    if (text.includes(bad)) throw new Error(`${path.relative(REPO, file)} contains "${bad}"`);
  }
  if (/uk_live_[A-Za-z0-9]{32}/.test(text)) throw new Error(`${path.relative(REPO, file)} contains an API key`);
}

export const freePort = () =>
  new Promise<number>((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => r(port));
    });
  });

/** A Chrome someone else started (a hosted browser, a teammate's agent): debugging port open, several tabs. */
export async function startChrome(urls: string[]): Promise<{ cdpUrl: string; tabs: () => Promise<{ url: string; type: string }[]>; stop: () => void }> {
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

