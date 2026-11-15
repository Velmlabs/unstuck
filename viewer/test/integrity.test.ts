// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
// @ts-expect-error plain .mjs build script
import { withIntegrity } from '../scripts/integrity.mjs';

const sri = (s: string) => `sha384-${createHash('sha384').update(s).digest('base64')}`;

describe('withIntegrity: index.html pins the exact script and stylesheet it loads', () => {
  const files: Record<string, string> = { 'assets/a.js': 'console.log(1)', 'assets/b.css': 'body{}' };
  const read = (p: string) => Buffer.from(files[p]!);
  it('adds integrity to module scripts and stylesheets, for absolute and versioned paths', () => {
    const html = '<script type="module" crossorigin src="/v/1.2.3/assets/a.js"></script>\n<link rel="stylesheet" crossorigin href="/v/1.2.3/assets/b.css">';
    const out = withIntegrity(html, read, '/v/1.2.3/');
    expect(out).toContain(`src="/v/1.2.3/assets/a.js" integrity="${sri('console.log(1)')}"`);
    expect(out).toContain(`href="/v/1.2.3/assets/b.css" integrity="${sri('body{}')}"`);
  });
  it('works with the root base too, and refuses a tag it cannot pin', () => {
    expect(withIntegrity('<script type="module" crossorigin src="/assets/a.js"></script>', read, '/')).toContain('integrity="sha384-');
    expect(() => withIntegrity('<script type="module" src="https://cdn.example/x.js"></script>', read, '/')).toThrow('cannot pin https://cdn.example/x.js');
  });
});

describe('pinPages: index.html and pair.html are both pinned', () => {
  it('rewrites both pages in a build folder, and leaves sw.js alone', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    // @ts-expect-error plain .mjs build script
    const { pinPages } = await import('../scripts/integrity.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets/i.js'), 'i');
    fs.writeFileSync(path.join(dir, 'assets/p.js'), 'p');
    fs.writeFileSync(path.join(dir, 'sw.js'), 'sw');
    fs.writeFileSync(path.join(dir, 'index.html'), '<script type="module" src="/assets/i.js"></script>');
    fs.writeFileSync(path.join(dir, 'pair.html'), '<script type="module" src="/assets/p.js"></script>');
    pinPages(dir, '/');
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain(sri('i'));
    expect(fs.readFileSync(path.join(dir, 'pair.html'), 'utf8')).toContain(sri('p'));
    expect(fs.readFileSync(path.join(dir, 'sw.js'), 'utf8')).toBe('sw');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('the hosted build', () => {
  it('lists pair.html and sw.js in SHA256SUMS.json, and pins pair.html', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    const out = path.join(__dirname, '../dist-hosted/v', version);
    if (!fs.existsSync(path.join(out, 'SHA256SUMS.json'))) return; // produced by `pnpm build`; e2e/alerts.test.ts needs it too
    const sums = JSON.parse(fs.readFileSync(path.join(out, 'SHA256SUMS.json'), 'utf8'));
    expect(Object.keys(sums.files)).toEqual(expect.arrayContaining(['index.html', 'pair.html', 'sw.js']));
    expect(fs.readFileSync(path.join(out, 'pair.html'), 'utf8')).toContain('integrity="sha384-');
  });
});
