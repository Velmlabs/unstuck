// What each published artifact may contain: nothing but what's listed, so no sources, tests,
// source maps or secrets ship. Each function returns a list of problems; empty means the contents are right.
import { PLATFORMS } from './platforms.mjs';

const TS_PACKAGES = ['@velmlabs/unstuck-protocol', '@velmlabs/unstuck-core', '@velmlabs/unstuck'];
const BASE = ['package.json', 'README.md', 'LICENSE'];
const COMPILED = /^dist\/(?!.*\.test\.)[\w./-]+\.(js|d\.ts)$/;

function problems(label, files, required, allowed) {
  const missing = required.filter((f) => !files.includes(f)).map((f) => `${label}: missing ${f}`);
  const unexpected = files.filter((f) => !required.includes(f) && !allowed(f)).map((f) => `${label}: unexpected file ${f}`);
  return [...missing, ...unexpected];
}

/** `files` are the tarball's paths without the leading `package/`. */
export function tarballProblems(name, files) {
  if (TS_PACKAGES.includes(name)) return problems(name, files, [...BASE, 'dist/index.js'], (f) => COMPILED.test(f));
  if (name === '@velmlabs/unstuck-engine') return problems(name, files, [...BASE, 'bin/unstuck-engine.mjs'], () => false);
  const platform = PLATFORMS.find((p) => name === `@velmlabs/unstuck-engine-${p.id}`);
  if (platform) return problems(name, files, [...BASE, `bin/${platform.exe}`], () => false);
  return [`${name}: not a package this release publishes`];
}

/** `wheel` is the file name (it carries the version and platform tag); `files` its archive paths. */
export function wheelProblems(wheel, files) {
  const m = /^unstuck-([^-]+)-py3-none-(.+)\.whl$/.exec(wheel);
  const platform = m && PLATFORMS.find((p) => p.wheel === m[2]);
  if (!platform) return [`${wheel}: not a platform this release builds`];
  const info = `unstuck-${m[1]}.dist-info`;
  const required = [`unstuck/_bin/${platform.exe}`, ...['METADATA', 'WHEEL', 'RECORD', 'licenses/LICENSE'].map((f) => `${info}/${f}`)];
  const allowed = (f) => /^unstuck\/[\w]+\.py$/.test(f) || f === 'unstuck/py.typed' || f === `${info}/entry_points.txt`;
  return problems(wheel, files, required, allowed);
}
