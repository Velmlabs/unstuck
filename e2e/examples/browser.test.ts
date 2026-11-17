// The Unstuck Browser examples, each run to a real rescue: the wrapped page meets the challenge site's Cloudflare check,
// the person solves it and taps Done, and the example carries on.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actAsHuman, assertShownFile, chromiumNoSandbox, example, exampleEnv, REPO, requirementsWithoutUnstuck, runExample, startChrome } from './harness';
import { startChallengeSite, type ChallengeSite } from '../browser/challenge-site';

let site: ChallengeSite;
beforeAll(async () => (site = await startChallengeSite()));
afterAll(() => site?.close());

const home = () => ({ UNSTUCK_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-example-home-')) });

async function rescued(run: Awaited<ReturnType<typeof runExample>>) {
  site.solve();
  await actAsHuman(run.link, 'done');
  return run.finish();
}

describe('Unstuck Browser examples', () => {
  it('browser-playwright-ts: goto a challenge, Done → carries on', async () => {
    site.reset();
    const run = await runExample('pnpm', ['start', `${site.url}/cf`], { cwd: example('browser-playwright-ts'), env: exampleEnv(home()) });
    const r = await rescued(run);
    expect(r.status, r.stdout).toBe('resolved');
    expect(r.stdout).toContain('now on "Shop"');
    expect(r.code).toBe(0);
  });

  it('browser-puppeteer and browser-playwright-py do the same', async () => {
    site.reset();
    const pp = await runExample('pnpm', ['start', `${site.url}/cf`], { cwd: example('browser-puppeteer'), env: exampleEnv({ ...home(), PUPPETEER_EXECUTABLE_PATH: chromiumNoSandbox() }) });
    expect((await rescued(pp)).status).toBe('resolved');
    site.reset();
    const py = await runExample(
      'uv',
      ['run', '--project', path.join(REPO, 'sdk-py'), '--with-requirements', requirementsWithoutUnstuck(example('browser-playwright-py/requirements.txt')), 'python', 'main.py', `${site.url}/cf`],
      { cwd: example('browser-playwright-py'), env: exampleEnv(home()) },
    );
    const r = await rescued(py);
    expect(r.status, r.stdout).toBe('resolved');
    expect(r.stdout).toContain('now on "Shop"');
  });

  it('browser-use unstuck_tools.py: check_page with no model key takes over and reports solved', async () => {
    site.reset();
    const chrome = await startChrome(['about:blank']);
    try {
      const run = await runExample(
        'uv',
        ['run', '--project', path.join(REPO, 'sdk-py'), '--with-requirements', requirementsWithoutUnstuck(example('browser-use/requirements.txt')), 'python', 'unstuck_tools.py', `${site.url}/cf`],
        { cwd: example('browser-use'), env: exampleEnv({ ...home(), ANTHROPIC_API_KEY: '', CDP_URL: chrome.cdpUrl }), timeoutMs: 600_000 },
      );
      const r = await rescued(run);
      expect(r.stdout).toContain('A person solved the check on 127.0.0.1');
      expect(r.status).toBe('resolved');
    } finally {
      chrome.stop();
    }
  });

  it('shown files use final names only', () => {
    for (const f of ['browser-playwright-ts/index.ts', 'browser-puppeteer/index.ts', 'browser-playwright-py/main.py', 'browser-use/unstuck_tools.py', 'mcp-browser/claude-code.sh', 'mcp-browser/codex.toml', 'cloudflare-worker/src/session-store.ts'])
      assertShownFile(example(f));
    expect(fs.readFileSync(example('browser-playwright-ts/index.ts'), 'utf8')).toContain('unstuck.wrap(await browser.newPage()');
  });
});
