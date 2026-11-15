#!/usr/bin/env node
// Fails if an edge entry's import graph reaches a Node built-in or the engine binary.
// Follows relative imports and @velmlabs/* workspace packages (via their `exports`, honouring `workerd`).
// Usage: node scripts/check-edge-graph.mjs <entry> [<entry> ...]
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILTINS = new Set(builtinModules);
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx'];
const SPECIFIERS = [
  /\b(?:import|export)\s[^'"`]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const ENGINE_PACKAGE = '@velmlabs/unstuck-engine';
const CONDITIONS = ['workerd', 'import', 'default'];

const isBuiltin = (s) => s.startsWith('node:') || BUILTINS.has(s) || BUILTINS.has(s.split('/')[0]);
const isFile = (f) => fs.existsSync(f) && fs.statSync(f).isFile();
const show = (f) => {
  const rel = path.relative(process.cwd(), f);
  return rel.startsWith('..') ? f : rel;
};

function withExtension(base) {
  const candidates = [base];
  // TypeScript sources import their own files with a .js specifier.
  const swapped = base.replace(/\.(?:m?js|cjs)$/, '');
  if (swapped !== base) candidates.push(swapped);
  for (const c of candidates) {
    for (const ext of EXTENSIONS) if (isFile(c + ext)) return c + ext;
    for (const ext of EXTENSIONS.slice(1)) if (isFile(path.join(c, 'index' + ext))) return path.join(c, 'index' + ext);
  }
  return null;
}

function pick(target) {
  if (typeof target === 'string') return target;
  for (const condition of CONDITIONS) if (target && condition in target) return pick(target[condition]);
  return null;
}

function packageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

function resolveWorkspace(specifier, fromDir) {
  const [scope, pkgName, ...rest] = specifier.split('/');
  const dir = packageDir(`${scope}/${pkgName}`, fromDir);
  if (!dir) return null;
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const subpath = rest.length ? `./${rest.join('/')}` : '.';
  let target = null;
  if (pkg.exports) target = pick(typeof pkg.exports === 'string' || !('.' in pkg.exports) ? (subpath === '.' ? pkg.exports : null) : pkg.exports[subpath]);
  else if (subpath === '.') target = pkg.main ?? 'index.js';
  return target ? withExtension(path.resolve(dir, target)) : null;
}

/** `file → specifier` for every Node built-in or engine-binary import reachable from `entry`. */
export function findEdgeViolations(entry) {
  const violations = [];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    const found = [];
    for (const re of SPECIFIERS) for (const m of text.matchAll(re)) found.push({ index: m.index, specifier: m[1] });
    found.sort((a, b) => a.index - b.index);
    for (const { specifier } of found) {
      const flag = () => violations.push(`${show(file)} → ${specifier}`);
      if (isBuiltin(specifier)) flag();
      else if (specifier === ENGINE_PACKAGE || specifier.startsWith(`${ENGINE_PACKAGE}/`)) flag();
      else {
        const dir = path.dirname(file);
        const resolved = specifier.startsWith('.')
          ? withExtension(path.resolve(dir, specifier))
          : specifier.startsWith('@velmlabs/')
            ? resolveWorkspace(specifier, dir)
            : null;
        if (!resolved) continue;
        if (path.basename(resolved) === 'engine-process.ts' || resolved.startsWith(path.join(ROOT, 'engine') + path.sep))
          violations.push(`${show(file)} → ${specifier} (${show(resolved)})`);
        else visit(resolved);
      }
    }
  };
  visit(path.resolve(ROOT, entry));
  return violations;
}

export function main(entries, log = console.log) {
  if (!entries.length) {
    log('usage: node scripts/check-edge-graph.mjs <entry> [<entry> ...]');
    return 2;
  }
  const violations = entries.flatMap(findEdgeViolations);
  for (const v of violations) log(v);
  if (violations.length) return 1;
  log(`check-edge-graph: no Node built-ins or engine in the graph of ${entries.join(', ')}`);
  return 0;
}

/* v8 ignore next 3 -- CLI hand-off */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
