// Self-hosting the relay: the Docker image and the bundled relay must keep working (they broke silently before).
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const json = (p) => JSON.parse(read(p));
const dockerfile = read('relay-node/Dockerfile');

describe('relay Docker image', () => {
  it('copies every workspace package the relay and the viewer depend on (dev ones too: pnpm resolves them)', () => {
    const wanted = new Set();
    for (const pkg of ['relay-node', 'viewer', 'relay-core', 'protocol', 'core']) {
      const p = json(`${pkg}/package.json`);
      for (const [name, v] of Object.entries({ ...p.dependencies, ...p.devDependencies })) if (String(v).startsWith('workspace:')) wanted.add(name);
    }
    const dirOf = { '@velmlabs/unstuck-protocol': 'protocol', '@velmlabs/unstuck-core': 'core', '@velmlabs/unstuck-relay-core': 'relay-core', '@velmlabs/unstuck-viewer': 'viewer' };
    for (const name of wanted) {
      const dir = dirOf[name];
      expect(dir, `${name} has no known folder`).toBeDefined();
      expect(dockerfile).toContain(`COPY ${dir} ./${dir}`);
      expect(dockerfile).toMatch(new RegExp(`packages:[^']*- ${dir}\\\\n`));
    }
  });

  it('runs the bundled relay with plain node (no tsx, no npm install in the final image)', () => {
    const final = dockerfile.slice(dockerfile.lastIndexOf('FROM '));
    expect(final).toContain('CMD ["node", "relay.mjs"]');
    expect(final).not.toMatch(/npm install|tsx|pnpm/);
    expect(json('relay-node/package.json').scripts.bundle).toMatch(/^esbuild src\/bin\.ts --bundle --platform=node/);
  });
});

describe('bundled relay', () => {
  it('builds and answers /healthz with plain node', async () => {
    execFileSync('pnpm', ['--filter', '@velmlabs/unstuck-relay', 'bundle'], { stdio: 'ignore' });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['relay-node/dist/relay.mjs'], { env: { ...process.env, PORT: String(port), UNSTUCK_AGENT_KEYS: 'k', UNSTUCK_VIEWER_DIR: 'viewer/dist' }, stdio: 'ignore' });
    try {
      let body = null;
      for (let i = 0; i < 50 && body === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        body = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json(), () => null);
      }
      expect(body).toEqual({ ok: true });
    } finally {
      child.kill();
    }
  }, 60_000);
});
