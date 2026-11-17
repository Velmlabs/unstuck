import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CHROME_NOT_FOUND, OBSCURA_NOT_FOUND, chromeCandidates, findChrome, launchChrome, launchObscura } from '../src/browser/launcher';

const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { executablePath(): string } };

function script(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-browser-'));
  const file = path.join(dir, 'browser.mjs');
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('findChrome', () => {
  it('CHROME_PATH wins, and a missing one is named', () => {
    expect(findChrome({ platform: 'linux', env: { CHROME_PATH: '/opt/c' }, home: '/h', exists: (p) => p === '/opt/c' || p === '/usr/bin/chromium' })).toBe('/opt/c');
    expect(() => findChrome({ platform: 'linux', env: { CHROME_PATH: '/opt/c' }, home: '/h', exists: (p) => p === '/usr/bin/chromium' })).toThrow('CHROME_PATH points to /opt/c, which does not exist');
    expect(findChrome({ platform: 'linux', env: {}, home: '/h', exists: (p) => p === '/usr/bin/chromium' || p === '/snap/bin/chromium' })).toBe('/usr/bin/chromium');
  });

  it.each(['linux', 'darwin', 'win32'] as const)('candidates on %s include system Chrome, then Playwright builds newest first', (platform) => {
    const listDir = () => ['chromium-1100', 'ffmpeg-1011', 'chromium-1243', 'chromium_headless_shell-1243', 'chromium-998'];
    const env = platform === 'win32' ? { PROGRAMFILES: 'C:\\PF', 'PROGRAMFILES(X86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\L' } : {};
    const c = chromeCandidates({ platform, env, home: '/h', listDir });
    const expected = {
      linux: [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/h/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
        '/h/.cache/ms-playwright/chromium-1243/chrome-linux/chrome',
        '/h/.cache/ms-playwright/chromium-1100/chrome-linux64/chrome',
      ],
      darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/h/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/h/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      ],
      win32: [
        'C:\\PF\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\PF86\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\L\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\L\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe',
        'C:\\L\\ms-playwright\\chromium-1243\\chrome-win\\chrome.exe',
      ],
    }[platform];
    expect(c.slice(0, expected.length)).toEqual(expected);
    expect(c.some((p) => p.includes('chromium-998'))).toBe(true);
    expect(c.findIndex((p) => p.includes('chromium-998'))).toBeGreaterThan(c.findIndex((p) => p.includes('chromium-1100')));
    expect(c.some((p) => p.includes('headless_shell') || p.includes('ffmpeg'))).toBe(false);
  });

  it('PLAYWRIGHT_BROWSERS_PATH replaces the default cache; a missing cache folder is fine', () => {
    const c = chromeCandidates({ platform: 'linux', env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' }, home: '/h', listDir: (d) => (d === '/opt/pw' ? ['chromium-7'] : []) });
    expect(c).toContain('/opt/pw/chromium-7/chrome-linux64/chrome');
    expect(chromeCandidates({ platform: 'linux', env: {}, home: '/nonexistent-home' })).toHaveLength(5);
    expect(chromeCandidates({ platform: 'darwin', env: {}, home: '/h', listDir: () => ['chromium-5'] })).toContain('/h/Library/Caches/ms-playwright/chromium-5/chrome-mac/Chromium.app/Contents/MacOS/Chromium');
  });

  it('nothing found → the exact hint', () => expect(() => findChrome({ platform: 'linux', env: {}, home: '/h', exists: () => false })).toThrow(CHROME_NOT_FOUND));

  it('finds a real binary with the default existence check', () => {
    const exe = chromium.executablePath();
    expect(findChrome({ platform: 'linux', env: { CHROME_PATH: exe }, home: '/h' })).toBe(exe);
  });
});

describe('launchChrome', () => {
  it('launches Playwright’s Chromium, connects, and stop() kills it and removes its profile', async () => {
    const b = await launchChrome({ path: chromium.executablePath(), isRoot: process.getuid?.() === 0 });
    expect(b.kind).toBe('chrome');
    expect(b.cdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    const version = await fetch(b.cdpUrl.replace(/^ws:\/\/([^/]+)\/.*$/, 'http://$1/json/version')).then((r) => r.json());
    expect(version.Browser).toMatch(/Chrome/);
    const pid = (b as unknown as { pid: number }).pid;
    const dir = (b as unknown as { userDataDir: string }).userDataDir;
    expect(fs.existsSync(dir)).toBe(true);
    await b.stop();
    expect(alive(pid)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    await b.stop(); // twice is fine
  }, 30_000);

  it('a binary that exits at once reports its stderr', async () => {
    const bin = script("for (let i = 0; i < 25; i++) console.error('line ' + i); console.error('boom'); process.exit(1);");
    const err = await launchChrome({ path: bin }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('boom');
    expect((err as Error).message).toContain('line 24');
    expect((err as Error).message).not.toContain('line 4\n');
  });

  it('a binary that never prints the DevTools line times out, and is killed', async () => {
    const bin = script("console.error('starting'); setInterval(() => {}, 1000);");
    const err = await launchChrome({ path: bin, startTimeoutMs: 300 }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/did not start within 0\.3 s[\s\S]*starting/);
  });

  it('a binary that cannot be started is an error', async () => {
    await expect(launchChrome({ path: '/nonexistent/chrome' })).rejects.toThrow(/could not start \/nonexistent\/chrome/);
  });

  it('passes --no-sandbox only as root', async () => {
    const seen: string[][] = [];
    const bin = script("console.error('DevTools listening on ws://127.0.0.1:1/devtools/browser/x'); setInterval(() => {}, 1000);");
    for (const isRoot of [true, false]) {
      const b = await launchChrome({
        path: bin,
        isRoot,
        spawn: ((cmd: string, args: string[], o: object) => {
          seen.push(args);
          return (require('node:child_process') as typeof import('node:child_process')).spawn(cmd, args, o as never);
        }) as never,
      });
      await b.stop();
    }
    expect(seen[0]).toContain('--no-sandbox');
    expect(seen[1]).not.toContain('--no-sandbox');
    expect(seen[1]).toEqual(expect.arrayContaining(['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank']));
  });

  it('stop() escalates to SIGKILL for a browser that ignores SIGTERM', async () => {
    const bin = script("process.on('SIGTERM', () => {}); console.error('DevTools listening on ws://127.0.0.1:1/devtools/browser/x'); setInterval(() => {}, 1000);");
    const b = await launchChrome({ path: bin, stopGraceMs: 200 } as never);
    const pid = (b as unknown as { pid: number }).pid;
    await b.stop();
    expect(alive(pid)).toBe(false);
  });
});

describe('a browser outlives no engine', () => {
  it('if the engine dies without stopping it (kill -9, a crash), the reaper kills the browser and removes its profile', async () => {
    const bin = script("process.on('SIGTERM', () => {}); console.error('DevTools listening on ws://127.0.0.1:1/devtools/browser/x'); setInterval(() => {}, 1000);");
    const b = await launchChrome({ path: bin });
    const { pid, userDataDir } = b as unknown as { pid: number; userDataDir: string };
    const reaper = (b as unknown as { reaper: { stdin: { destroy(): void } } }).reaper;
    expect(alive(pid)).toBe(true);
    reaper.stdin.destroy(); // what the engine's death does to the reaper's pipe
    await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
    await expect.poll(() => fs.existsSync(userDataDir), { timeout: 5000 }).toBe(false);
  }, 20_000);

  it('a normal stop() also ends the reaper, which then kills nothing', async () => {
    const bin = script("console.error('DevTools listening on ws://127.0.0.1:1/devtools/browser/x'); setInterval(() => {}, 1000);");
    const b = await launchChrome({ path: bin });
    const reaperPid = (b as unknown as { reaper: { pid: number } }).reaper.pid;
    await b.stop();
    await expect.poll(() => alive(reaperPid), { timeout: 5000 }).toBe(false);
  });
});

const require = createRequire(import.meta.url);

describe('launchObscura', () => {
  it('launchObscura polls /json/version until it answers', async () => {
    const bin = script(`
import http from 'node:http';
const args = process.argv.slice(2);
if (args[0] !== 'serve' || !args.includes('--allow-private-network')) process.exit(3);
const port = Number(args[args.indexOf('--port') + 1]);
setTimeout(() => http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ Browser: 'Obscura/1', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/o' }));
}).listen(port, '127.0.0.1'), 300);`);
    const t0 = Date.now();
    const b = await launchObscura({ path: bin });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(b.kind).toBe('obscura');
    expect(b.cdpUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/o$/);
    await b.stop();
  });

  it('an Obscura that exits is an error with its output, and one that never answers times out', async () => {
    const dead = script("console.error('obscura: bad flag'); process.exit(2);");
    await expect(launchObscura({ path: dead })).rejects.toThrow(/obscura: bad flag/);
    const mute = script('setInterval(() => {}, 1000);');
    await expect(launchObscura({ path: mute, startTimeoutMs: 400 })).rejects.toThrow(/did not start within 0\.4 s/);
  });

  it('names the missing-binary hint', () => {
    expect(OBSCURA_NOT_FOUND).toBe('Obscura not found: pass --obscura-path <path to the obscura binary> or set OBSCURA_PATH.');
  });
});
