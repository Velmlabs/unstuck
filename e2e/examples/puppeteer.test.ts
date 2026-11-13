import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { actAsHuman, assertShownFile, chromiumNoSandbox, example, exampleEnv, runExample, startSite } from './harness';

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => (site = await startSite()));
afterAll(() => site?.close());

describe('Puppeteer example', () => {
  it('puppeteer: launch, takeover(page), Done → resolved', async () => {
    const run = await runExample('pnpm', ['start', site.url], { cwd: example('puppeteer'), env: exampleEnv({ PUPPETEER_EXECUTABLE_PATH: chromiumNoSandbox() }) });
    await actAsHuman(run.link, 'done');
    const r = await run.finish();
    expect(r.status, r.stdout).toBe('resolved');
    expect(r.code).toBe(0);
  });

  it('shown file uses final names and marks the snippet', () => {
    assertShownFile(example('puppeteer/index.ts'));
    const text = fs.readFileSync(example('puppeteer/index.ts'), 'utf8');
    expect(text).toContain("import { Unstuck } from '@velmlabs/unstuck';");
    expect(text).toContain('// #region snippet');
  });
});
