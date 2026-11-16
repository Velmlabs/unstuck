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

describe('the pair page is installable', () => {
  it('links a manifest that starts at /pair, and the hosted folder carries it', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const html = fs.readFileSync(path.join(__dirname, '../pair.html'), 'utf8');
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/manifest.webmanifest'), 'utf8'));
    expect(m).toMatchObject({ name: 'Unstuck', short_name: 'Unstuck', display: 'standalone', start_url: '/pair', scope: '/' });
    expect(fs.existsSync(path.join(__dirname, '../public', m.icons[0].src))).toBe(true);
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    const sums = path.join(__dirname, '../dist-hosted/v', version, 'SHA256SUMS.json');
    if (fs.existsSync(sums)) expect(Object.keys(JSON.parse(fs.readFileSync(sums, 'utf8')).files)).toEqual(expect.arrayContaining(['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png']));
  });

  it("has what Chrome needs to offer an install: an id and 192 and 512 PNG icons (one maskable) that match their generator", async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/manifest.webmanifest'), 'utf8')) as {
      id: string;
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    };
    expect(m.id).toBe('/pair');
    // @ts-expect-error a plain .mjs script
    const { iconPng } = await import('../scripts/apple-touch-icon.mjs');
    for (const size of [192, 512]) {
      const icon = m.icons.find((i) => i.sizes === `${size}x${size}` && i.purpose === 'any')!;
      expect(icon).toMatchObject({ src: `icon-${size}.png`, type: 'image/png' });
      const png = fs.readFileSync(path.join(__dirname, '../public', icon.src));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
      expect(Buffer.compare(iconPng(size), png)).toBe(0);
    }
    expect(m.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    // Relative icon paths: each hosted /v/<version>/ folder serves its own.
    expect(m.icons.every((i) => !i.src.startsWith('/'))).toBe(true);
  });

  it('links a 180×180 PNG apple-touch-icon that matches its generator, and the hosted folder carries and links it', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const html = fs.readFileSync(path.join(__dirname, '../pair.html'), 'utf8');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    const png = fs.readFileSync(path.join(__dirname, '../public/apple-touch-icon.png'));
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
    // @ts-expect-error a plain .mjs script
    const { iconPng } = await import('../scripts/apple-touch-icon.mjs');
    expect(Buffer.compare(iconPng(), png)).toBe(0);
    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    const out = path.join(__dirname, '../dist-hosted/v', version);
    if (!fs.existsSync(path.join(out, 'SHA256SUMS.json'))) return;
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(out, 'SHA256SUMS.json'), 'utf8')).files)).toContain('apple-touch-icon.png');
    expect(fs.readFileSync(path.join(out, 'pair.html'), 'utf8')).toContain(`href="/v/${version}/apple-touch-icon.png"`);
  });
});
