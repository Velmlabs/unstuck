// Shared suites every SessionStore and StoreFs must pass (exported to sdk-ts and engine as
// @velmlabs/unstuck-core/testing/store; workspace-only, never published).
import { describe, it, expect, beforeEach } from 'vitest';
import type { StoredCookie } from '@velmlabs/unstuck-protocol';
import type { SessionStore, StoreFs } from '../src/guard/store';

export const NOW = 1_800_000_000_000;
export const cookie = (name: string, value: string, domain: string, expires = -1): StoredCookie => ({ name, value, domain, path: '/', expires, httpOnly: false, secure: true });

/** `make` must return an empty store whose clock reads NOW. */
export function describeSessionStore(name: string, make: () => Promise<SessionStore>): void {
  describe(`SessionStore: ${name}`, () => {
    let s: SessionStore;
    beforeEach(async () => {
      s = await make();
    });

    it('round-trips a site and normalizes the domain', async () => {
      await s.save('www.shop.example', [cookie('cf_clearance', 'abc', '.shop.example', 2e9)], 'UA/1');
      expect(await s.load('shop.example')).toMatchObject({ site: 'shop.example', userAgent: 'UA/1', solvedAt: NOW, cookies: [expect.objectContaining({ name: 'cf_clearance', value: 'abc' })] });
      expect(await s.load('other.example')).toBeNull();
    });

    it('merges cookies by name, domain and path', async () => {
      await s.save('shop.example', [cookie('a', '1', 'shop.example'), cookie('b', '1', 'shop.example')], 'UA/1');
      await s.save('shop.example', [cookie('a', '2', 'shop.example')], 'UA/2');
      const r = await s.load('shop.example');
      expect(r?.userAgent).toBe('UA/2');
      expect(r?.cookies.map((c) => `${c.name}=${c.value}`).sort()).toEqual(['a=2', 'b=1']);
    });

    it('drops cookies past their expiry on load, and the site with them', async () => {
      await s.save('shop.example', [cookie('old', 'x', 'shop.example', 1000)], 'UA/1');
      expect(await s.load('shop.example')).toBeNull();
    });

    it('keeps session cookies (expires -1)', async () => {
      await s.save('shop.example', [cookie('sid', 'x', 'shop.example', -1)], 'UA/1');
      expect((await s.load('shop.example'))?.cookies).toHaveLength(1);
    });

    it('forget and forgetAll clear entries', async () => {
      await s.save('a.example', [cookie('x', '1', 'a.example')], 'UA');
      await s.save('b.example', [cookie('x', '1', 'b.example')], 'UA');
      await s.forget('www.a.example');
      expect(await s.load('a.example')).toBeNull();
      expect(await s.load('b.example')).not.toBeNull();
      await s.forgetAll();
      expect(await s.load('b.example')).toBeNull();
    });

    it('updateRescues is atomic and returns the new list', async () => {
      expect(await s.updateRescues((t) => [...t, NOW])).toEqual([NOW]);
      await Promise.all([1, 2, 3].map((i) => s.updateRescues((t) => [...t, NOW + i])));
      expect(await s.updateRescues((t) => t)).toHaveLength(4);
    });
  });
}

/** `make` returns a StoreFs and an empty directory to write in. */
export function describeStoreFs(name: string, make: () => Promise<{ fs: StoreFs; dir: string }>): void {
  describe(`StoreFs: ${name}`, () => {
    it('reads null for a missing file, then what was written', async () => {
      const { fs, dir } = await make();
      const file = `${dir}/p/sites.json`;
      expect(await fs.read(file)).toBeNull();
      await fs.writeAtomic(file, '{"a":1}');
      expect(await fs.read(file)).toBe('{"a":1}');
    });

    it('withLock runs one holder at a time', async () => {
      const { fs, dir } = await make();
      const file = `${dir}/lock/sites.json`;
      const order: string[] = [];
      const hold = (id: string) =>
        fs.withLock(file, async () => {
          order.push(`${id}+`);
          await new Promise((r) => setTimeout(r, 30));
          order.push(`${id}-`);
        });
      await Promise.all([hold('a'), hold('b')]);
      expect(order.join(' ')).toMatch(/^(a\+ a- b\+ b-|b\+ b- a\+ a-)$/);
    });
  });
}
