// The README is the 30-second version: what Unstuck does, what it looks like (real captures), how to start. Its docs
// links must be pages that exist (the same list is checked against the docs build in the private Cloud repo:
// web/test/docs-content.test.ts "every docs slug the README links to exists").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const md = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const SLUGS = JSON.parse(fs.readFileSync(path.join(root, 'scripts/readme-doc-slugs.json'), 'utf8'));
const STRIP = ['strip-1-stuck', 'strip-2-alert', 'strip-3-live', 'strip-4-carries-on'];
const slug = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');

describe('README', () => {
  it('is the 30-second version', () => {
    const lines = md.split('\n');
    expect(lines.length).toBeLessThanOrEqual(170);
    expect(lines.slice(0, 15).join('\n')).toContain('docs/assets/unstuck-loop.gif');
    for (const s of ['npm install @velmlabs/unstuck', 'pip install unstuck', 'https://unstuck.sh/docs/requirements/', 'Apache-2.0', "A person solves every check; the site's terms still apply."]) expect(md, s).toContain(s);
    for (const n of STRIP) expect(md, n).toContain(`docs/assets/${n}.png`);
  });

  it('every image exists and is within budget', () => {
    for (const [, src] of md.matchAll(/(?:src="|\]\()((?:\.\/)?docs\/assets\/[^")]+\.(?:gif|png|svg))/g)) {
      const f = path.join(root, src);
      expect(fs.existsSync(f), src).toBe(true);
      const max = src.endsWith('.gif') ? 5 * 1024 * 1024 : 300 * 1024;
      expect(fs.statSync(f).size, src).toBeLessThanOrEqual(max);
    }
  });

  it('every repo link exists; every docs link is a known slug', () => {
    for (const [, href] of md.matchAll(/\]\(((?!https?:|#|mailto:)[^)\s]+)\)/g)) expect(fs.existsSync(path.join(root, href.split('#')[0])), href).toBe(true);
    for (const [, s] of md.matchAll(/https:\/\/unstuck\.sh\/docs\/([a-z-]*)\/?(?:[#)\s"]|$)/g)) expect(SLUGS, s).toContain(s);
  });

  it('no Cloud page links to a README anchor that is gone', () => {
    const cloud = path.join(root, '../unstuck-cloud/web');
    if (!fs.existsSync(cloud)) return console.log('skipped: no ../unstuck-cloud checkout');
    const anchors = new Set([...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])).concat('readme'));
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'dist' || e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(cloud).filter((f) => /\.(md|html|tsx?)$/.test(f)))
      for (const [, a] of fs.readFileSync(f, 'utf8').matchAll(/github\.com\/velmlabs\/unstuck(?:\/blob\/main\/README\.md)?#([a-z0-9-]+)/g)) expect(anchors.has(a), `${f} → #${a}`).toBe(true);
  });
});
