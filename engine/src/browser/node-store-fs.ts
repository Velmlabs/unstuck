// Node's StoreFs for remembered sites (the same file lives in sdk-ts and the engine; keep them identical).
import { mkdir, readFile, writeFile, chmod, rename, open, unlink, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { StoreFs } from '@velmlabs/unstuck-core';

const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;

/** Where Unstuck keeps its local data: `UNSTUCK_HOME`, else `~/.unstuck`. */
export function unstuckHome(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return env.UNSTUCK_HOME || join(home, '.unstuck');
}

async function lock(file: string): Promise<() => Promise<void>> {
  const path = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const start = Date.now();
  for (;;) {
    try {
      const h = await open(path, 'wx', 0o600);
      await h.close();
      return () => unlink(path).catch(() => {});
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // A lock left by a crashed process doesn't block forever.
      const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await unlink(path).catch(() => {});
      else if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`[unstuck] ${path} is held by another process; try again`);
      else await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
}

export function nodeStoreFs(): StoreFs {
  return {
    async read(path) {
      try {
        return await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    async writeAtomic(path, data) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await chmod(tmp, 0o600); // the umask may have narrowed or widened it
      await rename(tmp, path);
    },
    async withLock(path, fn) {
      const release = await lock(path);
      try {
        return await fn();
      } finally {
        await release();
      }
    },
  };
}
