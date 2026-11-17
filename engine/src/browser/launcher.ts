// Finds and starts the browser Unstuck Browser drives: a system Chrome or Chromium (or Playwright's), or Obscura.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const CHROME_NOT_FOUND =
  'No Chrome or Chromium found. Run `npx playwright install chromium`, or set CHROME_PATH to your Chrome or Chromium binary.';
export const OBSCURA_NOT_FOUND = 'Obscura not found: pass --obscura-path <path to the obscura binary> or set OBSCURA_PATH.';

const START_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 3_000;
const LOG_LINES = 20;

export interface CandidateOptions {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  listDir?: (dir: string) => string[];
}

const defaultListDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/** Playwright's Chromium builds in `root`, newest first (chromium-<n>; not the headless shell). */
function playwrightBuilds(root: string, listDir: (dir: string) => string[]): string[] {
  return listDir(root)
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map((m) => m[0]);
}

/** Where Chrome or Chromium usually lives, most likely first. */
export function chromeCandidates(o: CandidateOptions): string[] {
  const listDir = o.listDir ?? defaultListDir;
  const pwRoot = o.env.PLAYWRIGHT_BROWSERS_PATH;
  if (o.platform === 'win32') {
    const w = path.win32;
    const local = o.env.LOCALAPPDATA ?? w.join(o.home, 'AppData', 'Local');
    const system = [o.env.PROGRAMFILES, o.env['PROGRAMFILES(X86)'], local].filter((d): d is string => !!d).map((d) => w.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    const root = pwRoot ?? w.join(local, 'ms-playwright');
    return [...system, ...playwrightBuilds(root, listDir).flatMap((b) => [w.join(root, b, 'chrome-win64', 'chrome.exe'), w.join(root, b, 'chrome-win', 'chrome.exe')])];
  }
  const p = path.posix;
  if (o.platform === 'darwin') {
    const root = pwRoot ?? p.join(o.home, 'Library', 'Caches', 'ms-playwright');
    const testing = 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      p.join(o.home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ...playwrightBuilds(root, listDir).flatMap((b) =>
        ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac'].flatMap((d) => [p.join(root, b, d, testing), p.join(root, b, d, 'Chromium.app/Contents/MacOS/Chromium')]),
      ),
    ];
  }
  const root = pwRoot ?? p.join(o.home, '.cache', 'ms-playwright');
  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    ...playwrightBuilds(root, listDir).flatMap((b) => [p.join(root, b, 'chrome-linux64', 'chrome'), p.join(root, b, 'chrome-linux', 'chrome')]),
  ];
}

/** CHROME_PATH if set (it must exist), else the first candidate that exists. */
export function findChrome(o: CandidateOptions & { exists?: (p: string) => boolean }): string {
  const exists = o.exists ?? ((p: string) => fs.existsSync(p));
  const forced = o.env.CHROME_PATH;
  if (forced) {
    if (!exists(forced)) throw new Error(`CHROME_PATH points to ${forced}, which does not exist`);
    return forced;
  }
  const found = chromeCandidates(o).find(exists);
  if (!found) throw new Error(CHROME_NOT_FOUND);
  return found;
}

export interface LaunchedBrowser {
  cdpUrl: string;
  kind: 'chrome' | 'obscura';
  stop(): Promise<void>;
}

interface LaunchOptions {
  path: string;
  spawn?: typeof nodeSpawn;
  startTimeoutMs?: number;
  /** How long stop() waits after SIGTERM before SIGKILL. */
  stopGraceMs?: number;
}

/** The last lines a process printed, for an error message. */
function tail(proc: ChildProcess): () => string {
  const lines: string[] = [];
  const add = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) if (line.trim()) lines.push(line);
    if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
  };
  proc.stderr?.on('data', add);
  proc.stdout?.on('data', add);
  return () => lines.join('\n');
}

/** Ends the process group (SIGTERM, then SIGKILL after the grace), then runs `cleanup`. Safe to call twice. */
function stopper(proc: ChildProcess, graceMs: number, cleanup: () => void): () => Promise<void> {
  let stopping: Promise<void> | null = null;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid!, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {
        // already gone
      }
    }
  };
  return () =>
    (stopping ??= (async () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        const exited = new Promise<void>((r) => proc.once('exit', () => r()));
        signal('SIGTERM');
        const timer = setTimeout(() => signal('SIGKILL'), graceMs);
        await exited;
        clearTimeout(timer);
      }
      cleanup();
    })());
}

const seconds = (ms: number) => `${ms / 1000} s`;

/**
 * A tiny process that outlives a killed engine (kill -9, a crash): it holds a pipe from the engine, and when that
 * closes it kills the browser's process group and removes its profile. Without it, a browser in its own process group
 * would keep running, cookies and an open debugging port included. It ends as soon as the browser exits, so it never
 * signals a process group that was reused later. POSIX only (Windows has no process groups to reap).
 */
function startReaper(browser: ChildProcess, dir = ''): ChildProcess | null {
  if (process.platform === 'win32' || !browser.pid) return null;
  // `kill -9 -PGID` is the spelling every POSIX sh (dash too) accepts for a process group.
  let reaper: ChildProcess;
  try {
    reaper = nodeSpawn('sh', ['-c', 'cat >/dev/null; kill -9 -"$1" 2>/dev/null; if [ -n "$2" ]; then rm -rf -- "$2"; fi', 'unstuck-reaper', String(browser.pid), dir], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
  } catch {
    return null;
  }
  reaper.on('error', () => {});
  reaper.stdin?.on('error', () => {});
  reaper.unref();
  (reaper.stdin as unknown as { unref?: () => void } | null)?.unref?.();
  const end = () => {
    // A reaper whose pipe already closed is doing its job (killing, then removing the profile): leave it to finish.
    if (reaper.stdin?.destroyed) return;
    try {
      process.kill(-reaper.pid!, 'SIGKILL');
    } catch {
      // already gone
    }
  };
  if (browser.exitCode !== null || browser.signalCode !== null) end();
  else browser.once('exit', end);
  return reaper;
}

/** Starts headless Chrome on a free DevTools port with a throwaway profile. */
export async function launchChrome(o: LaunchOptions & { isRoot?: boolean }): Promise<LaunchedBrowser & { pid: number; userDataDir: string; reaper: ChildProcess | null }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-chrome-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check'];
  if (o.isRoot ?? process.getuid?.() === 0) args.push('--no-sandbox');
  args.push('about:blank');
  const removeDir = () => fs.rmSync(userDataDir, { recursive: true, force: true });
  const proc = (o.spawn ?? nodeSpawn)(o.path, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const output = tail(proc);
  const reaper = startReaper(proc, userDataDir);
  const stop = stopper(proc, o.stopGraceMs ?? STOP_GRACE_MS, removeDir);
  const timeoutMs = o.startTimeoutMs ?? START_TIMEOUT_MS;
  try {
    const cdpUrl = await new Promise<string>((resolve, reject) => {
      let seen = '';
      proc.stderr!.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
        if (m) resolve(m[1]!);
      });
      proc.once('error', (e) => reject(new Error(`could not start ${o.path}: ${e.message}`)));
      proc.once('exit', (code) => reject(new Error(`${o.path} exited with code ${code} before DevTools was ready:\n${output()}`)));
      setTimeout(() => reject(new Error(`${o.path} did not start within ${seconds(timeoutMs)}:\n${output()}`)), timeoutMs).unref();
    });
    return { cdpUrl, kind: 'chrome', pid: proc.pid!, userDataDir, stop, reaper };
  } catch (e) {
    await stop();
    throw e;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Starts Obscura's CDP server; it may reach this machine (the paint probe is served on 127.0.0.1). */
export async function launchObscura(o: LaunchOptions): Promise<LaunchedBrowser & { pid: number }> {
  const port = await freePort();
  const proc = (o.spawn ?? nodeSpawn)(o.path, ['serve', '--port', String(port), '--allow-private-network'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const output = tail(proc);
  startReaper(proc);
  const stop = stopper(proc, o.stopGraceMs ?? STOP_GRACE_MS, () => {});
  const timeoutMs = o.startTimeoutMs ?? START_TIMEOUT_MS;
  let failed: Error | null = null;
  proc.once('error', (e) => (failed ??= new Error(`could not start ${o.path}: ${e.message}`)));
  proc.once('exit', (code) => (failed ??= new Error(`${o.path} exited with code ${code} before its CDP server answered:\n${output()}`)));
  const end = Date.now() + timeoutMs;
  try {
    while (Date.now() < end) {
      if (failed) throw failed;
      const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(
        (r) => (r.ok ? (r.json() as Promise<{ webSocketDebuggerUrl?: string }>) : null),
        () => null,
      );
      if (version?.webSocketDebuggerUrl) return { cdpUrl: version.webSocketDebuggerUrl, kind: 'obscura', pid: proc.pid!, stop };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw failed ?? new Error(`${o.path} did not start within ${seconds(timeoutMs)}:\n${output()}`);
  } catch (e) {
    await stop();
    throw e;
  }
}
