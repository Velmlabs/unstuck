import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Unstuck, UnstuckEngineError } from '../src/index';
import { ENGINE, fakeEngine, launch, scriptedEngine } from './helpers';
import type { Browser } from './helpers';

let browser: Browser;
beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser.close();
});

describe('Unstuck', () => {
  it('calls onLink once with a localhost takeover URL, and resolves when the human taps Done', async () => {
    const page = await browser.newPage();
    await page.setContent('<p>hello</p>');
    const links: { url: string; reason: string }[] = [];
    const unstuck = new Unstuck({ enginePath: ENGINE, onLink: (l) => links.push(l) });
    const result = unstuck.takeover(page, { reason: 'Solve it', timeoutS: 30 });
    await vi.waitFor(() => expect(links).toHaveLength(1), { timeout: 10_000 });
    expect(links[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{22}#t=/);
    expect(links[0]!.reason).toBe('Solve it');

    const human = await browser.newPage();
    await human.goto(links[0]!.url);
    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved' });
    await unstuck.close();
    await page.close();
    await human.close();
  });

  it('Review Focus 3: closing the page mid-takeover returns failed/page_closed quickly', async () => {
    const page = await browser.newPage();
    const unstuck = new Unstuck({ enginePath: ENGINE, onLink: () => {} });
    const result = unstuck.takeover(page, { reason: 'x', timeoutS: 60 });
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    await page.close();
    await expect(result).resolves.toMatchObject({ status: 'failed', detail: 'page_closed' });
    expect(Date.now() - t0).toBeLessThan(1000);
    await unstuck.close();
  });

  it('prints the link to stderr by default', async () => {
    const page = await browser.newPage();
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const unstuck = new Unstuck({ enginePath: ENGINE });
    const result = unstuck.takeover(page, { reason: 'Need a human', timeoutS: 1 });
    await expect(result).resolves.toMatchObject({ status: 'timed_out' });
    expect(write.mock.calls.map((c) => String(c[0])).join('')).toMatch(/Unstuck: a human is needed \(Need a human\) → http:\/\/127\.0\.0\.1/);
    write.mockRestore();
    await unstuck.close();
    await page.close();
  });

  it('Review Focus 4: a missing engine rejects with UnstuckEngineError', async () => {
    const page = await browser.newPage();
    const err = await new Unstuck({ enginePath: '/nonexistent/unstuck-engine' }).takeover(page, { reason: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(UnstuckEngineError);
    expect(err.message).toContain('/nonexistent/unstuck-engine');
    expect(err.message).toContain('UNSTUCK_ENGINE_PATH');
    await page.close();
  });

  it('Review Focus 4: an engine that dies mid-takeover rejects, and the next call respawns', async () => {
    const page = await browser.newPage();
    const dying = scriptedEngine('process.exit(7);');
    const unstuck = new Unstuck({ enginePath: dying, onLink: () => {} });
    const err = await unstuck.takeover(page, { reason: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(UnstuckEngineError);
    expect(err.message).toBe('engine exited with code 7');

    const okEngine = scriptedEngine(
      "out({ id: m.id, result: { status: 'resolved', sessionId: 's', url: 'u', durationS: 0 } });",
    );
    (unstuck as unknown as { opts: { enginePath: string } }).opts.enginePath = okEngine;
    await expect(unstuck.takeover(page, { reason: 'x' })).resolves.toMatchObject({ status: 'resolved' });
    await unstuck.close();
    await page.close();
  });

  it('answers the engine for unknown page ids with an error instead of hanging', async () => {
    const page = await browser.newPage();
    const engine = scriptedEngine(`
      out({ id: 900, method: 'cdp.send', params: { pageId: 'nope', method: 'Runtime.evaluate' } });
      out({ id: 901, method: 'cdp.subscribe', params: { pageId: 'nope', events: ['X'] } });
      globalThis.pending = m.id;`
      + `
      readline.createInterface({ input: process.stdin }).on('line', (l2) => {
        const r = JSON.parse(l2);
        if (r.id === 900 && r.error) out({ id: globalThis.pending, result: { status: 'failed', sessionId: 's', url: 'u', durationS: 0, detail: r.error.message } });
      });`);
    const unstuck = new Unstuck({ enginePath: engine, onLink: () => {} });
    await expect(unstuck.takeover(page, { reason: 'x' })).resolves.toMatchObject({ status: 'failed', detail: 'unknown page nope' });
    await unstuck.close();
    await page.close();
  });

  it('close() before any takeover is a no-op', async () => {
    await expect(new Unstuck({ enginePath: ENGINE }).close()).resolves.toBeUndefined();
  });

  it('close() kills an engine that ignores shutdown; the pending takeover rejects', async () => {
    const stubborn = fakeEngine(`
import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'engine.hello') process.stdout.write(JSON.stringify({ id: m.id, result: { engineVersion: 'x', protocolVersion: 1 } }) + '\\n');
});
process.stdin.on('end', () => {});
setInterval(() => {}, 1000);`);
    const u = new Unstuck({ enginePath: stubborn, onLink: () => {} });
    const page = await browser.newPage();
    const p = u.takeover(page, { reason: 'x' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await u.close();
    expect(Date.now() - t0).toBeLessThan(3500);
    await expect(p).resolves.toBeInstanceOf(UnstuckEngineError);
    await page.close();
  });

  it('Review Focus 5: after a timed-out takeover the agent process exits on its own', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'fixtures', 'timeout-then-exit.mts')], {
      env: { ...process.env, UNSTUCK_ENGINE_PATH: ENGINE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const killer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const code = await new Promise<number | null>((r) => child.on('close', r));
    clearTimeout(killer);
    expect(out.trim()).toBe('timed_out');
    expect(code).toBe(0);
  });
});
