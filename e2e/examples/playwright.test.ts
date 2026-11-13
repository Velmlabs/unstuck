import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { actAsHuman, assertShownFile, example, exampleEnv, REPO, runExample, startSite } from './harness';

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => (site = await startSite()));
afterAll(() => site?.close());

describe('Playwright examples', () => {
  it("playwright-ts: a human taps Done, the example prints 'Takeover resolved'", async () => {
    const run = await runExample('pnpm', ['start', site.url], { cwd: example('playwright-ts'), env: exampleEnv() });
    await actAsHuman(run.link, 'done');
    const r = await run.finish();
    expect(r.status, r.stdout).toBe('resolved');
    expect(r.code).toBe(0);
  });

  it('playwright-py: same, via uv', async () => {
    const run = await runExample('uv', ['run', '--project', path.join(REPO, 'sdk-py'), '--with', 'playwright==1.63.0', 'python', 'main.py', site.url], { cwd: example('playwright-py'), env: exampleEnv() });
    await actAsHuman(run.link, 'done');
    const r = await run.finish();
    expect(r.status, r.stdout).toBe('resolved');
  });

  it('shown files use final names only', () => {
    for (const f of ['playwright-ts/index.ts', 'playwright-py/main.py']) assertShownFile(example(f));
    expect(fs.readFileSync(example('playwright-ts/index.ts'), 'utf8')).toContain("import { Unstuck } from '@velmlabs/unstuck';");
    const pkg = JSON.parse(fs.readFileSync(example('playwright-ts/package.json'), 'utf8'));
    expect(pkg.dependencies['@velmlabs/unstuck']).toBe('workspace:unstuck@*');
    expect(pkg.dependencies.unstuck).toBeUndefined();
  });
});
