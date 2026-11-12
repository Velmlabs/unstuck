import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// The sandbox's pre-installed Playwright is used (a second workspace copy would not find its browser),
// so tests type the few members they use instead of importing Playwright's types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Browser = any;
export const { chromium } = require('playwright') as { chromium: { launch(): Promise<Browser> } };
export const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../engine/dist/unstuck-engine');
export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export async function launch(): Promise<Browser> {
  return chromium.launch();
}

/** Writes an executable fake engine script and returns its path. */
export function fakeEngine(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-engine-'));
  const file = path.join(dir, 'engine.mjs');
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

/** Fake engine that answers hello and then runs `onTakeover` JS when a takeover request arrives. */
export function scriptedEngine(onTakeover: string): string {
  return fakeEngine(`
import readline from 'node:readline';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'engine.hello') out({ id: m.id, result: { engineVersion: 'fake', protocolVersion: 1 } });
  else if (m.method === 'takeover') { ${onTakeover} }
  else if (m.method === 'shutdown') { out({ id: m.id, result: {} }); process.exit(0); }
});`);
}
