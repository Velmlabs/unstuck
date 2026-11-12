#!/usr/bin/env node
// Thin process entry point (excluded from coverage): wires real stdio into the tested main().
import { main } from './cli';
import { ASSETS } from './assets.gen';

main(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, assets: ASSETS }).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`[unstuck] fatal: ${e?.stack ?? e}\n`);
    process.exit(1);
  },
);
