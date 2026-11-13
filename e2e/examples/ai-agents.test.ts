import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { actAsHuman, assertShownFile, chromiumNoSandbox, example, exampleEnv, REPO, requirementsWithoutUnstuck, runExample, startChrome, startSite } from './harness';

// No model key here: each example skips its AI step and asks for help directly, so the Unstuck half runs for real.
const noKeys = { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' };

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => (site = await startSite()));
afterAll(() => site?.close());

describe('AI browser-agent examples', () => {
  it("browser-use: the ask_human tool takes over the browser-use Chrome's tab", async () => {
    const chrome = await startChrome([`${site.url}captcha`]);
    try {
      const run = await runExample(
        'uv',
        ['run', '--project', path.join(REPO, 'sdk-py'), '--with-requirements', requirementsWithoutUnstuck(example('browser-use/requirements.txt')), 'python', 'main.py'],
        { cwd: example('browser-use'), env: exampleEnv({ ...noKeys, CDP_URL: chrome.cdpUrl }), timeoutMs: 600_000 },
      );
      await actAsHuman(run.link, 'done');
      const r = await run.finish();
      expect(r.stdout).toContain('no model key');
      expect(r.status, r.stdout).toBe('resolved');
    } finally {
      chrome.stop();
    }
  });

  it("stagehand: takes over the page in Stagehand's browser", async () => {
    const run = await runExample('pnpm', ['start', `${site.url}captcha`], { cwd: example('stagehand'), env: exampleEnv({ ...noKeys, CHROME_PATH: chromiumNoSandbox() }) });
    await actAsHuman(run.link, 'done');
    const r = await run.finish();
    expect(r.stdout).toContain('no model key');
    expect(r.status, r.stdout).toBe('resolved');
    expect(r.code).toBe(0);
  });

  it('shown files use final names only', () => {
    for (const f of ['browser-use/main.py', 'stagehand/index.ts']) assertShownFile(example(f));
  });
});
