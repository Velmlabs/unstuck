import { describe, it, expect } from 'vitest';
import { resolveEnginePath, resolveViaEngine, spawnEngine } from '../src/engine-process';
import { UnstuckEngineError } from '../src/errors';
import { optionEnv } from '../src/options';
import { ENGINE, fakeEngine } from './helpers';

describe('resolveEnginePath', () => {
  it('prefers the explicit option, then UNSTUCK_ENGINE_PATH', () => {
    expect(resolveEnginePath({ enginePath: '/a' }, { UNSTUCK_ENGINE_PATH: '/b' })).toBe('/a');
    expect(resolveEnginePath({}, { UNSTUCK_ENGINE_PATH: '/b' })).toBe('/b');
  });

  it('falls back to the platform package', () => {
    expect(resolveEnginePath({}, {}, (id) => `/pkgs/${id}`)).toBe(`/pkgs/@velmlabs/unstuck-engine-${process.platform}-${process.arch}/bin/unstuck-engine`);
  });

  it('throws UnstuckEngineError naming what it tried when nothing resolves', () => {
    const fail = () => {
      throw new Error('not found');
    };
    expect(() => resolveEnginePath({}, {}, fail)).toThrow(UnstuckEngineError);
    try {
      resolveEnginePath({}, {}, fail);
    } catch (e) {
      expect((e as Error).message).toContain(`@velmlabs/unstuck-engine-${process.platform}-${process.arch}`);
      expect((e as Error).message).toContain('Reinstall @velmlabs/unstuck without skipping optional dependencies');
      expect((e as Error).message).toContain('set UNSTUCK_ENGINE_PATH');
    }
  });
});

describe('spawnEngine', () => {
  it('starts the real engine and completes the hello handshake', async () => {
    const e = await spawnEngine(ENGINE, {});
    expect(e.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
    e.kill();
    await e.exited;
  });

  it('passes host and port through to the engine', async () => {
    const e = await spawnEngine(fakeEngine(`
import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  process.stdout.write(JSON.stringify({ id: m.id, result: { engineVersion: process.argv.slice(2).join(' '), protocolVersion: 1 } }) + '\\n');
});`), { host: '0.0.0.0', port: 4321 });
    expect(e.engineVersion).toBe('--stdio --host 0.0.0.0 --port 4321');
    e.kill();
  });

  const ECHO_ENV = `
import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  const v = [process.env.UNSTUCK_RELAY_URL, process.env.UNSTUCK_AGENT_KEY, process.env.UNSTUCK_API_KEY, process.env.PATH ? 'path' : 'nopath'].join('|');
  process.stdout.write(JSON.stringify({ id: m.id, result: { engineVersion: v, protocolVersion: 1 } }) + '\\n');
});`;

  it('passes relay/agentKey as before (merged over the parent environment)', async () => {
    const e = await spawnEngine(fakeEngine(ECHO_ENV), { env: { ...process.env, ...optionEnv({ relay: 'wss://relay.example', agentKey: 'KEY' }) } });
    expect(e.engineVersion).toBe('wss://relay.example|KEY||path');
    e.kill();
  });

  it('apiKey option beats UNSTUCK_RELAY_URL in the environment', async () => {
    const parent = { ...process.env, UNSTUCK_RELAY_URL: 'wss://from-env', UNSTUCK_AGENT_KEY: 'ENVKEY' };
    const e = await spawnEngine(fakeEngine(ECHO_ENV), { env: { ...parent, ...optionEnv({ apiKey: 'k' }) } });
    expect(e.engineVersion).toBe('||k|path');
    e.kill();
  });

  it('uses the process environment when no env is given', async () => {
    process.env.UNSTUCK_TEST_MARKER = 'from-process-env';
    try {
      const e = await spawnEngine(
        fakeEngine(`
import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  process.stdout.write(JSON.stringify({ id: m.id, result: { engineVersion: String(process.env.UNSTUCK_TEST_MARKER), protocolVersion: 1 } }) + '\\n');
});`),
        {},
      );
      expect(e.engineVersion).toBe('from-process-env');
      e.kill();
    } finally {
      delete process.env.UNSTUCK_TEST_MARKER;
    }
  });

  it('Review Focus 4: a missing binary rejects with UnstuckEngineError naming the path', async () => {
    const t0 = Date.now();
    const err = await spawnEngine('/nonexistent/unstuck-engine', {}).catch((e) => e);
    expect(err).toBeInstanceOf(UnstuckEngineError);
    expect(err.message).toContain('/nonexistent/unstuck-engine');
    expect(err.message).toContain('UNSTUCK_ENGINE_PATH');
    expect(err.enginePath).toBe('/nonexistent/unstuck-engine');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('Review Focus 4: an engine that exits before hello rejects', async () => {
    const err = await spawnEngine(fakeEngine('process.exit(3)'), {}).catch((e) => e);
    expect(err).toBeInstanceOf(UnstuckEngineError);
    expect(err.message).toMatch(/exited with code 3 before the handshake/);
  });

  it('Final I7: an engine that never answers the handshake times out, is killed, and names UNSTUCK_ENGINE_PATH', async () => {
    const silent = fakeEngine('setInterval(() => {}, 1000);');
    const t0 = Date.now();
    const err = await spawnEngine(silent, { handshakeTimeoutMs: 300 }).catch((e) => e);
    expect(err).toBeInstanceOf(UnstuckEngineError);
    expect(err.message).toMatch(/did not answer the handshake within 0\.3 s/);
    expect(err.message).toContain('UNSTUCK_ENGINE_PATH');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('Final I7: early-exit and refused-handshake errors also name UNSTUCK_ENGINE_PATH', async () => {
    const early = await spawnEngine(fakeEngine('process.exit(3)'), {}).catch((e) => e);
    expect(early.message).toContain('UNSTUCK_ENGINE_PATH');
  });

  it('a protocol mismatch rejects with UnstuckEngineError', async () => {
    const err = await spawnEngine(
      fakeEngine(`
import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  process.stdout.write(JSON.stringify({ id: m.id, error: { code: 'protocol_mismatch', message: 'old engine' } }) + '\\n');
});`),
      {},
    ).catch((e) => e);
    expect(err).toBeInstanceOf(UnstuckEngineError);
    expect(err.message).toContain('old engine');
    expect(err.message).toContain('UNSTUCK_ENGINE_PATH');
  });
});

describe('resolveViaEngine', () => {
  const base = { resolve: (id: string) => (id === '@velmlabs/unstuck-engine/package.json' ? '/nm/@velmlabs/unstuck-engine/package.json' : `/sdk-sees/${id}`) };
  it('looks for the platform package next to @velmlabs/unstuck-engine (strict node_modules layouts)', () => {
    const make = (from: string) => ({ resolve: (id: string) => `${from}::${id}` });
    expect(resolveViaEngine('@velmlabs/unstuck-engine-linux-x64/bin/unstuck-engine', base, make)).toBe('/nm/@velmlabs/unstuck-engine/package.json::@velmlabs/unstuck-engine-linux-x64/bin/unstuck-engine');
  });
  it('falls back to resolving from the SDK itself', () => {
    const make = () => ({
      resolve: () => {
        throw new Error('not found');
      },
    });
    expect(resolveViaEngine('x/bin', base, make)).toBe('/sdk-sees/x/bin');
  });
});
