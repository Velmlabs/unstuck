#!/usr/bin/env node
// @velmlabs/unstuck-engine's bin: finds the engine binary for this computer (from its platform package) and runs it.
// So `npx -y @velmlabs/unstuck-engine --mcp` works everywhere npm installed the matching optional dependency.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const SUPPORTED = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'];

/** Absolute path of the engine binary for `platform`-`arch`. */
export function binaryPath(platform = process.platform, arch = process.arch, resolve = createRequire(import.meta.url).resolve) {
  const id = `${platform}-${arch}`;
  if (!SUPPORTED.includes(id)) throw new Error(`Unstuck has no engine for ${id}. Supported: ${SUPPORTED.join(', ')}`);
  const pkg = `@velmlabs/unstuck-engine-${id}`;
  try {
    return resolve(`${pkg}/bin/unstuck-engine${platform === 'win32' ? '.exe' : ''}`);
  } catch {
    throw new Error(`${pkg} is not installed. It's an optional dependency of @velmlabs/unstuck-engine: reinstall without --no-optional / --omit=optional.`);
  }
}

/** Runs the binary with `args` and this process's stdio; resolves with its exit code. Signals are forwarded. */
export function run(args, bin = binaryPath()) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'inherit' });
    const forward = (sig) => () => child.kill(sig);
    const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((sig) => [sig, forward(sig)]);
    for (const [sig, h] of handlers) process.on(sig, h);
    child.on('exit', (code, signal) => {
      for (const [sig, h] of handlers) process.off(sig, h);
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 0)); // like a shell: 128 + signal number
    });
    child.on('error', (e) => {
      console.error(`unstuck-engine: ${e.message}`);
      resolve(1);
    });
  });
}

/* c8 ignore start: the entry point, exercised by the release dry run */
const invokedDirectly = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exit(await run(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
/* c8 ignore stop */
