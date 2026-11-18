// The shell commands' run directory: one file per running request (how `wait` and `cancel` reach the background
// process that holds it), one lock per tab (one request per tab), and the paint-check cache. Mode 0700/0600; the
// control endpoint listens on 127.0.0.1 only and wants the request's random token.
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { unstuckHome } from '../browser/node-store-fs';

export interface RunFile {
  id: string;
  pid: number;
  port: number;
  token: string;
  kind: 'rescue' | 'takeover' | 'ask';
  tab?: string;
  browser?: string;
  startedAt: number;
  expiresAt: number;
  /** The start result (link and all), so a repeated start on the same tab can answer with it. */
  start?: Record<string, unknown>;
}

const ID = /^[A-Za-z0-9_-]{16,64}$/;
/** A tab lock with no request id yet older than this belongs to a start that died: it is taken over. */
export const LOCK_START_GRACE_MS = 60_000;
export const LOST = { status: 'failed', detail: 'request_lost' } as const;

export function runDir(env: Record<string, string | undefined>): string {
  const dir = path.join(unstuckHome(env), 'run');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** Whether a process with this pid exists (EPERM means it does, under another user). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const runPath = (dir: string, id: string) => path.join(dir, `${id}.json`);

export async function writeRunFile(dir: string, f: RunFile): Promise<void> {
  const tmp = `${runPath(dir, f.id)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(f), { mode: 0o600 });
  await rename(tmp, runPath(dir, f.id));
}

export async function readRunFile(dir: string, id: string): Promise<RunFile | null> {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(await readFile(runPath(dir, id), 'utf8')) as RunFile;
  } catch {
    return null;
  }
}

export async function removeRunFile(dir: string, id: string): Promise<void> {
  if (ID.test(id)) await unlink(runPath(dir, id)).catch(() => {});
}

/** Running requests; files of processes that are gone are removed on the way. */
export async function listRunning(dir: string): Promise<RunFile[]> {
  const out: RunFile[] = [];
  for (const name of await readdir(dir)) {
    const m = /^([A-Za-z0-9_-]{16,64})\.json$/.exec(name);
    if (!m) continue;
    const f = await readRunFile(dir, m[1]!);
    if (f && alive(f.pid)) out.push(f);
    else await removeRunFile(dir, m[1]!);
  }
  return out;
}

const lockPath = (dir: string, tabKey: string) => path.join(dir, `tab-${createHash('sha256').update(tabKey).digest('hex').slice(0, 32)}.lock`);

/** Frees a tab's lock (the request on it has ended). */
export async function releaseTab(dir: string, tabKey: string): Promise<void> {
  await unlink(lockPath(dir, tabKey)).catch(() => {});
}

export type TabClaim = { claimed: true; setLockId(id: string): Promise<void>; release(): Promise<void> } | { claimed: false; id: string | null };

/**
 * One request per tab: an atomic create of `tab-<sha256(tabKey)>.lock`. A lock naming a request that is gone, or with
 * no id after LOCK_START_GRACE_MS, is taken over. `id: null` means another start for this tab is still under way.
 */
export async function claimTab(dir: string, tabKey: string): Promise<TabClaim> {
  const lock = lockPath(dir, tabKey);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(lock, 'wx', 0o600);
      await fh.close();
      return {
        claimed: true,
        setLockId: (id) => writeFile(lock, id, { mode: 0o600 }),
        release: () => unlink(lock).catch(() => {}),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const id = (await readFile(lock, 'utf8').catch(() => '')).trim();
    if (id) {
      const f = await readRunFile(dir, id);
      if (f && alive(f.pid)) return { claimed: false, id };
    } else {
      const age = Date.now() - (await stat(lock).then((s) => s.mtimeMs, () => 0));
      if (age < LOCK_START_GRACE_MS) return { claimed: false, id: null };
    }
    await unlink(lock).catch(() => {});
  }
  return { claimed: false, id: null };
}

export interface ControlHandlers {
  token: string;
  /** The result, or `waiting` once maxWaitS has passed; `signal` aborts when the caller goes away. */
  result(maxWaitS: number, signal: AbortSignal): Promise<Record<string, unknown>>;
  cancel(): Promise<Record<string, unknown>>;
  /** A caller asked for the result (the keep timer starts on the first read of a final result). */
  onRead(): void;
}

function tokenOk(header: string | undefined, token: string): boolean {
  const got = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '');
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** `GET /result?max_wait_s=N` and `POST /cancel` on 127.0.0.1, for the request's token only. */
export async function startControlServer(h: ControlHandlers): Promise<{ port: number; host: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!tokenOk(req.headers.authorization, h.token)) return send(401, { error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    if (req.method === 'GET' && url.pathname === '/result') {
      h.onRead();
      const maxWaitS = Math.max(0, Number(url.searchParams.get('max_wait_s') ?? 0) || 0);
      return void h.result(maxWaitS, ac.signal).then((r) => send(200, r), (e: Error) => send(500, { status: 'failed', detail: e.message }));
    }
    if (req.method === 'POST' && url.pathname === '/cancel') return void h.cancel().then((r) => send(200, r), (e: Error) => send(500, { status: 'failed', detail: e.message }));
    send(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    host: '127.0.0.1',
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

/** Asks a request's background process; a process or port that is gone reads as `request_lost` (and its file goes). */
export async function askControl(dir: string, f: RunFile, route: '/result' | '/cancel', maxWaitS = 0): Promise<Record<string, unknown>> {
  const lost = async () => {
    await removeRunFile(dir, f.id);
    return { ...LOST };
  };
  if (!alive(f.pid)) return lost();
  const query = route === '/result' ? `?max_wait_s=${maxWaitS}` : '';
  try {
    const res = await fetch(`http://127.0.0.1:${f.port}${route}${query}`, { method: route === '/cancel' ? 'POST' : 'GET', headers: { authorization: `Bearer ${f.token}` } });
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return lost();
  }
}

export const paintCachePath = (dir: string) => path.join(dir, 'paint.json');
