#!/usr/bin/env node
// Fails if runtime-agnostic packages import Node built-ins.
// Usage: node scripts/check-runtime-agnostic.mjs <dir> [<dir> ...]
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';

const BUILTINS = new Set(builtinModules);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SPECIFIERS = [
  /\b(?:import|export)\s[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function isBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true;
  return BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0]);
}

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (SOURCE.test(entry.name)) yield full;
  }
}

export function findViolations(dirs) {
  const violations = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of sourceFiles(dir)) {
      const text = fs.readFileSync(file, 'utf8');
      const found = [];
      for (const re of SPECIFIERS) {
        for (const m of text.matchAll(re)) if (isBuiltin(m[1])) found.push({ index: m.index, specifier: m[1] });
      }
      found.sort((a, b) => a.index - b.index);
      for (const { specifier } of found) violations.push({ file, specifier });
    }
  }
  return violations;
}

export function main(dirs, log = console.log) {
  const violations = findViolations(dirs);
  for (const v of violations) log(`${v.file}: imports Node built-in '${v.specifier}'`);
  if (violations.length) return 1;
  log(`check-runtime-agnostic: no Node built-ins in ${dirs.join(', ')}`);
  return 0;
}

/* v8 ignore next 3 -- CLI hand-off */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
