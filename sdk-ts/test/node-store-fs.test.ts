import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createFileSessionStore, parseSitesFile, profileFile } from '@velmlabs/unstuck-core';
import { describeSessionStore, describeStoreFs, NOW, cookie } from '@velmlabs/unstuck-core/testing/store';
import { nodeStoreFs, unstuckHome } from '../src/browser/node-store-fs';

const tmp = () => mkdtemp(join(tmpdir(), 'unstuck-store-'));

describeStoreFs('node', async () => ({ fs: nodeStoreFs(), dir: await tmp() }));
describeSessionStore('file on node', async () => createFileSessionStore(nodeStoreFs(), profileFile(await tmp(), 'default'), { now: () => NOW }));

describe('nodeStoreFs', () => {
  let home: string;
  beforeEach(async () => {
    home = await tmp();
  });

  it.skipIf(process.platform === 'win32')('writes sites.json 0600 in a 0700 folder', async () => {
    const file = profileFile(home, 'default');
    await createFileSessionStore(nodeStoreFs(), file).save('shop.example', [cookie('a', '1', 'shop.example')], 'UA');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
  });

  it('unstuckHome is UNSTUCK_HOME, else ~/.unstuck', () => {
    expect(unstuckHome({ UNSTUCK_HOME: '/x' })).toBe('/x');
    expect(unstuckHome({}, '/home/ann')).toBe(join('/home/ann', '.unstuck'));
  });

  it('a stale lock left by a crashed process is taken over', async () => {
    const { utimes, writeFile } = await import('node:fs/promises');
    const file = profileFile(home, 'default');
    await nodeStoreFs().writeAtomic(file, '');
    await writeFile(`${file}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    await utimes(`${file}.lock`, old, old);
    await expect(nodeStoreFs().withLock(file, async () => 'ran')).resolves.toBe('ran');
  });

  // Review Focus 4
  it('two processes saving to one profile at once keep both sites and every rescue', async () => {
    const file = profileFile(home, 'default');
    const child = (site: string) =>
      new Promise<void>((resolve, reject) => {
        const p = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fixtures/store-child.ts'), file, site], { stdio: 'inherit' });
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
      });
    await Promise.all([child('a.example'), child('b.example')]);
    const f = parseSitesFile(await readFile(file, 'utf8'), Date.now());
    expect(Object.keys(f.sites).sort()).toEqual(['a.example', 'b.example']);
    expect(f.sites['a.example']?.cookies).toHaveLength(50);
    expect(f.rescues).toHaveLength(100);
  }, 60_000);
});
