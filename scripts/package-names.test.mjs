// Publishing 0.4.0: every package and import uses the published names (@velmlabs/unstuck, @velmlabs/unstuck-*).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|tsx|mjs|js|json|py|toml|md|yaml|yml)$|Dockerfile$/.test(f) && !f.startsWith('docs/') && f !== 'pnpm-lock.yaml');

describe('package names', () => {
  // The npm name is @velmlabs/unstuck; Claude Code plugin manifests (.claude-plugin/) are rightly named "unstuck".
  it('no code, manifest or example uses the old names', () => {
    const offenders = [];
    for (const f of tracked) {
      if (!fs.existsSync(f)) continue;
      const text = fs.readFileSync(f, 'utf8');
      if (/@unstuck\//.test(text) || /from ['"]unstuck['"]|require\(['"]unstuck['"]\)|"unstuck": "workspace/.test(text) || (f.endsWith('package.json') && /^\s*"name": "unstuck",/m.test(text))) offenders.push(f);
    }
    expect(offenders.filter((f) => f !== 'scripts/package-names.test.mjs' && f !== 'e2e/examples/harness.ts')).toEqual([]);
  });

  it('workspace packages that are not published are private (no accidental pnpm -r publish)', () => {
    for (const dir of ['engine', 'viewer', 'relay-core', 'relay-node', 'relay-cloudflare', 'e2e']) expect(JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8')).private, dir).toBe(true);
  });

  it('the published packages carry their new names', () => {
    const name = (dir) => JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8')).name;
    expect([name('sdk-ts'), name('engine'), name('core'), name('protocol')]).toEqual(['@velmlabs/unstuck', '@velmlabs/unstuck-engine', '@velmlabs/unstuck-core', '@velmlabs/unstuck-protocol']);
  });
});
