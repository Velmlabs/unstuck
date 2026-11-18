// The shell commands through the real binary: rescue starts a detached background process, a killed `wait` doesn't
// end the request, the person solves it in a real viewer, and the background process goes away afterwards.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { actAsHuman, chromium, ENGINE } from './examples/harness';
import { startChallengeSite, type ChallengeSite } from './browser/challenge-site';

const run = promisify(execFile);

let site: ChallengeSite;
let chrome: { wsUrl: string; stop(): void };
beforeAll(async () => {
  site = await startChallengeSite();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-shell-chrome-'));
  const proc = spawn(chromium.executablePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-sandbox', `${site.url}/cf`], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let err = '';
    const t = setTimeout(() => reject(new Error(`chromium did not start: ${err}`)), 20_000);
    proc.stderr!.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) (clearTimeout(t), resolve(m[1]!));
    });
  });
  chrome = { wsUrl, stop: () => proc.kill('SIGKILL') };
  await new Promise((r) => setTimeout(r, 1500)); // the interstitial loads
}, 60_000);
afterAll(() => {
  chrome.stop();
  site.close();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function engine(args: string[], env: Record<string, string>): Promise<{ code: number; json: Record<string, any> }> {
  try {
    const { stdout } = await run(ENGINE, args, { env: { ...process.env, ...env }, timeout: 120_000 });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (e) {
    const err = e as { code: number; stdout: string };
    return { code: err.code, json: JSON.parse(err.stdout) };
  }
}

describe('unstuck shell commands (built binary)', () => {
  it('check → rescue → a killed wait → the person solves it → wait resolves; the background process then exits', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-shell-home-'));
    const env = { UNSTUCK_HOME: home, UNSTUCK_SHELL_KEEP_MS: '1500' };

    const check = await engine(['check', '--cdp', chrome.wsUrl], env);
    expect(check).toMatchObject({ code: 20, json: { status: 'check_found', check: { kind: 'challenge', vendor: 'cloudflare' } } });

    const start = await engine(['rescue', '--cdp', chrome.wsUrl], env);
    expect(start.code).toBe(10);
    const { id, link } = start.json;
    const runFile = JSON.parse(fs.readFileSync(path.join(home, 'run', `${id}.json`), 'utf8')) as { pid: number };
    expect(alive(runFile.pid)).toBe(true);

    // The agent's shell gives up on a wait: the request goes on.
    const killed = spawn(ENGINE, ['wait', id, '--max-wait', '60'], { env: { ...process.env, ...env }, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
    killed.kill('SIGKILL');
    expect(alive(runFile.pid)).toBe(true);

    site.solve();
    await actAsHuman(link, 'done');
    const done = await engine(['wait', id, '--max-wait', '60'], env);
    expect(done).toMatchObject({ code: 0, json: { status: 'resolved', check: { kind: 'challenge' } } });

    await expect.poll(() => alive(runFile.pid), { timeout: 15_000 }).toBe(false);
    expect(fs.readdirSync(path.join(home, 'run')).filter((n) => n.endsWith('.json') && n !== 'paint.json')).toEqual([]);
  }, 180_000);
});
