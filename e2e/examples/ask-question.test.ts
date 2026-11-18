import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assertShownFile, chromium, devices, example, exampleEnv, REPO, runExample } from './harness';

/** Opens the question link on an iPhone 13 and answers it: a choice by its label, or typed text. */
async function answerOnPhone(link: string, answer: { choice: string } | { text: string }): Promise<void> {
  const browser = await chromium.launch();
  try {
    const human = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
    await human.goto(link);
    await human.getByRole('button', { name: 'Start takeover' }).click();
    await human.getByRole('heading', { name: 'Which flight should I book?' }).waitFor({ timeout: 60_000 });
    if ('choice' in answer) await human.getByRole('button', { name: answer.choice }).click();
    else await human.getByLabel('Or write a reply').fill(answer.text);
    await human.getByRole('button', { name: 'Send answer' }).click();
    await human.getByRole('heading', { name: 'Answer sent' }).waitFor({ timeout: 30_000 });
  } finally {
    await browser.close();
  }
}

describe('ask-question example', () => {
  it("ask-question (TypeScript): the person picks a flight, the example prints it", async () => {
    const run = await runExample('pnpm', ['start'], { cwd: example('ask-question'), env: exampleEnv() });
    await answerOnPhone(run.link, { choice: '09:45 one stop, €180' });
    const r = await run.finish();
    expect(r.stdout).toContain('Question answered');
    expect(r.stdout).toContain('Answer: 09:45 one stop, €180');
    expect(r.code).toBe(0);
  });

  it('ask-question (Python): the person writes a reply instead, via uv', async () => {
    const run = await runExample('uv', ['run', '--project', path.join(REPO, 'sdk-py'), 'python', 'main.py'], { cwd: example('ask-question'), env: exampleEnv() });
    await answerOnPhone(run.link, { text: 'Neither, take the train' });
    const r = await run.finish();
    expect(r.stdout).toContain('Question answered');
    expect(r.stdout).toContain('Answer: Neither, take the train');
    expect(r.code).toBe(0);
  });

  it('shown files use final names only', () => {
    for (const f of ['ask-question/index.ts', 'ask-question/main.py', 'ask-question/requirements.txt']) assertShownFile(example(f));
    expect(fs.readFileSync(example('ask-question/index.ts'), 'utf8')).toContain("import { Unstuck } from '@velmlabs/unstuck';");
    expect(JSON.parse(fs.readFileSync(example('ask-question/package.json'), 'utf8')).dependencies['@velmlabs/unstuck']).toBe('workspace:*');
  });
});
