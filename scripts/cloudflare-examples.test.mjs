// The deployable Cloudflare examples (examples/cloudflare-worker, examples/cloudflare-agent): standalone, on the published
// package, with the bindings the guide (unstuck.sh/docs/cloudflare-workers) asks for and a working Deploy button.
import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** JSONC to JSON: drops // and /* *\/ comments outside strings, and trailing commas. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const s = end.exec(text)[0];
      out += s;
      i += s.length - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const examples = [
  { dir: 'examples/cloudflare-worker', extra: [] },
  { dir: 'examples/cloudflare-agent', extra: ['agents'] },
];

describe('parseJsonc', () => {
  it('keeps // inside strings and drops comments and trailing commas', () => {
    expect(parseJsonc('{\n  // a\n  "u": "https://x.y/*z*/", /* b */ "n": [1, 2,],\n}')).toEqual({ u: 'https://x.y/*z*/', n: [1, 2] });
  });
});

describe.each(examples)('$dir', ({ dir, extra }) => {
  const pkg = JSON.parse(read(`${dir}/package.json`));
  const wrangler = parseJsonc(read(`${dir}/wrangler.jsonc`));
  const readme = read(`${dir}/README.md`);

  it('depends on the published @velmlabs/unstuck 0.2.x and @cloudflare/puppeteer, with wrangler for dev', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies['@velmlabs/unstuck']).toMatch(/^\^0\.2\.\d+$/);
    expect(pkg.dependencies['@cloudflare/puppeteer']).toMatch(/^\^\d/);
    for (const name of extra) expect(pkg.dependencies[name]).toMatch(/^\^\d/);
    expect(pkg.devDependencies.wrangler).toMatch(/^\^4\./);
    expect(Object.keys(pkg.scripts).sort()).toEqual(['deploy', 'dev', 'typecheck']);
  });

  it('is outside the pnpm workspace, so it installs from npm like a user would', () => {
    expect(read('pnpm-workspace.yaml')).toContain(`- '!${dir}'`);
    expect(JSON.stringify(pkg)).not.toContain('workspace:');
  });

  it('has nodejs_compat, the browser binding, and a SQLite Durable Object with its migration', () => {
    expect(wrangler.main).toBe('src/index.ts');
    expect(existsSync(new URL(`../${dir}/src/index.ts`, import.meta.url))).toBe(true);
    expect(wrangler.compatibility_flags).toContain('nodejs_compat');
    expect(wrangler.browser).toEqual({ binding: 'BROWSER' });
    const [binding] = wrangler.durable_objects.bindings;
    expect(binding.class_name).toBe('PortalAgent');
    expect(wrangler.migrations[0].new_sqlite_classes).toEqual([binding.class_name]);
    const source = read(`${dir}/src/index.ts`);
    expect(source).toContain(`export class ${binding.class_name} extends`);
    expect(source).toContain(`${binding.name}: DurableObjectNamespace<${binding.class_name}>`);
  });

  it('keeps secrets out of wrangler.jsonc and describes them for the Deploy button', () => {
    expect(Object.keys(wrangler.vars).sort()).toEqual(['TARGET_URL', 'UNSTUCK_ALERTS']);
    const secrets = [...read(`${dir}/.dev.vars.example`).matchAll(/^(\w+)=/gm)].map((m) => m[1]);
    expect(secrets.sort()).toEqual(['CONTROL_TOKEN', 'UNSTUCK_API_KEY']);
    for (const name of [...secrets, ...Object.keys(wrangler.vars)]) expect(pkg.cloudflare.bindings[name]?.description, name).toBeTruthy();
  });

  it('has a README with the Deploy to Cloudflare button for this folder', () => {
    const url = `https://deploy.workers.cloudflare.com/?url=https://github.com/velmlabs/unstuck/tree/main/${dir}`;
    expect(readme).toContain(`[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](${url})`);
    for (const s of ['wrangler secret put UNSTUCK_API_KEY', 'wrangler secret put CONTROL_TOKEN', 'wrangler deploy', 'Authorization: Bearer', "alerts", 'required']) expect(readme).toContain(s);
  });

  it('is linked from the README, the roadmap and the skill', () => {
    expect(read('README.md')).toContain(`](${dir})`);
    expect(read('docs/roadmap/cloudflare-workers.md')).toContain(`](../../${dir})`);
    expect(read('plugins/unstuck/skills/unstuck/SKILL.md')).toContain(`https://github.com/velmlabs/unstuck/tree/main/${dir}`);
  });
});
