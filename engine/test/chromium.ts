// Test helper: a real Chromium with a DevTools port, from the sandbox's pre-installed Playwright.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { executablePath(): string } };

export interface DebugChromium {
  port: number;
  wsUrl: string;
  proc: ChildProcess;
  stop(): Promise<void>;
}

export async function startChromium(): Promise<DebugChromium> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-chrome-'));
  const proc = spawn(chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-sandbox', 'about:blank'], {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true, // own process group, so stop() can kill renderer/GPU children too
  });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(new Error(`chromium did not start: ${err}`)), 15_000);
    proc.stderr!.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    });
  });
  const port = Number(new URL(wsUrl).port);
  return {
    port,
    wsUrl,
    proc,
    async stop() {
      const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
      try {
        process.kill(-proc.pid!, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
      await exited;
      // Best effort: a temp profile left behind must never fail a test.
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      } catch {
        /* ignore */
      }
    },
  };
}
