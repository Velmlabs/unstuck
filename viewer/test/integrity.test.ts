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
