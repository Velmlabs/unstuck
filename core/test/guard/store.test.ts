import { describe, it, expect, vi } from 'vitest';
import { createMemorySessionStore, createFileSessionStore, parseSitesFile, profileFile, PROFILE_NAME, type StoreFs } from '../../src/guard/store';
import { describeSessionStore, describeStoreFs, NOW, cookie } from '../store-conformance';

/** An in-memory StoreFs with a real lock queue, so the file store's logic is tested without a disk. */
export function memoryFs(files = new Map<string, string>()): StoreFs {
  let chain = Promise.resolve();
  return {
    read: async (p) => files.get(p) ?? null,
    writeAtomic: async (p, d) => void files.set(p, d),
    withLock: <T>(_p: string, fn: () => Promise<T>) => {
      const run = chain.then(fn);
      chain = run.then(
        () => {},
        () => {},
      );
      return run;
    },
  };
}

describeSessionStore('memory', async () => createMemorySessionStore({ now: () => NOW }));
describeSessionStore('file on an in-memory fs', async () => createFileSessionStore(memoryFs(), '/h/profiles/default/sites.json', { now: () => NOW }));
describeStoreFs('in-memory fs', async () => ({ fs: memoryFs(), dir: '/tmp' }));

describe('file store', () => {
  it('a corrupt sites.json starts empty with one warning', async () => {
    const files = new Map([['/h/sites.json', '{"version":1,"sites":']]);
    const warn = vi.fn();
    const s = createFileSessionStore(memoryFs(files), '/h/sites.json', { now: () => NOW, warn });
    expect(await s.load('shop.example')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[unstuck] /h/sites.json is not a valid sites file; starting with no remembered sites');
  });

  it('writes the versioned format', async () => {
    const files = new Map<string, string>();
    const s = createFileSessionStore(memoryFs(files), '/h/sites.json', { now: () => NOW });
    await s.save('shop.example', [cookie('a', '1', 'shop.example')], 'UA');
    expect(JSON.parse(files.get('/h/sites.json')!)).toEqual({ version: 1, sites: { 'shop.example': { userAgent: 'UA', solvedAt: NOW, cookies: [cookie('a', '1', 'shop.example')] } }, rescues: [] });
  });
});

describe('parseSitesFile', () => {
  it('drops expired cookies, emptied sites and old rescues', () => {
    const text = JSON.stringify({
      version: 1,
      sites: { 'a.example': { userAgent: 'UA', solvedAt: 1, cookies: [cookie('x', '1', 'a.example', 1000)] }, 'b.example': { userAgent: 'UA', solvedAt: 1, cookies: [cookie('y', '1', 'b.example', 2e9)] } },
      rescues: [NOW - 3_600_001, NOW - 10],
    });
    const f = parseSitesFile(text, NOW);
    expect(Object.keys(f.sites)).toEqual(['b.example']);
    expect(f.rescues).toEqual([NOW - 10]);
  });

  it('an unknown version or no text is the empty file', () => {
    const warn = vi.fn();
    expect(parseSitesFile(JSON.stringify({ version: 2, sites: {}, rescues: [] }), NOW, warn)).toEqual({ version: 1, sites: {}, rescues: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(parseSitesFile(null, NOW, warn)).toEqual({ version: 1, sites: {}, rescues: [] });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('profileFile', () => {
  it('rejects "../etc" and "", accepts "default" and "mcp"', () => {
    expect(profileFile('/h', 'default')).toBe('/h/profiles/default/sites.json');
    expect(profileFile('/h', 'mcp')).toBe('/h/profiles/mcp/sites.json');
    for (const bad of ['../etc', '', 'a/b', 'x'.repeat(65), '-x']) expect(() => profileFile('/h', bad)).toThrow(TypeError);
    expect(() => profileFile('/h', '../etc')).toThrow('profile names are letters, digits, "-" and "_" (at most 64), e.g. "default"');
    expect(PROFILE_NAME.test('a_b-1')).toBe(true);
  });
});
