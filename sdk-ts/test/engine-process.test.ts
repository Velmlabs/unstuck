import { describe, it, expect } from 'vitest';
import { resolveEnginePath, spawnEngine } from '../src/engine-process';
import { UnstuckEngineError } from '../src/errors';
import { ENGINE, fakeEngine } from './helpers';

describe('resolveEnginePath', () => {
  it('prefers the explicit option, then UNSTUCK_ENGINE_PATH', () => {
    expect(resolveEnginePath({ enginePath: '/a' }, { UNSTUCK_ENGINE_PATH: '/b' })).toBe('/a');
    expect(resolveEnginePath({}, { UNSTUCK_ENGINE_PATH: '/b' })).toBe('/b');
  });

  it('falls back to the platform package', () => {
    expect(resolveEnginePath({}, {}, (id) => `/pkgs/${id}`)).toBe(`/pkgs/@unstuck/engine-${process.platform}-${process.arch}/bin/unstuck-engine`);
  });

  it('throws UnstuckEngineError naming what it tried when nothing resolves', () => {
    const fail = () => {
      throw new Error('not found');
    };
    expect(() => resolveEnginePath({}, {}, fail)).toThrow(UnstuckEngineError);
    try {
      resolveEnginePath({}, {}, fail);
    } catch (e) {
      expect((e as Error).message).toContain(`@unstuck/engine-${process.platform}-${process.arch}`);
      expect((e as Error).message).toContain('Set UNSTUCK_ENGINE_PATH');
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
  });
});
