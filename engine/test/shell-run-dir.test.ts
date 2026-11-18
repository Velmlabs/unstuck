import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askControl, claimTab, listRunning, readRunFile, removeRunFile, runDir, startControlServer, writeRunFile, type RunFile } from '../src/shell/run-dir';

let dir: string;
beforeEach(() => {
  dir = runDir({ UNSTUCK_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-run-')) });
});

const DEAD_PID = 2 ** 22 + 12345; // above Linux's pid_max default: never a live process
const file = (over: Partial<RunFile> = {}): RunFile => ({ id: 'abcdefghijklmnopqrstuv', pid: process.pid, port: 1, token: 't', kind: 'rescue', tab: 'T1', startedAt: 1, expiresAt: 2, ...over });

describe('run directory', () => {
  it('run dir is 0700 and run files 0600', async () => {
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    await writeRunFile(dir, file());
    expect(fs.statSync(path.join(dir, 'abcdefghijklmnopqrstuv.json')).mode & 0o777).toBe(0o600);
    expect(await readRunFile(dir, 'abcdefghijklmnopqrstuv')).toEqual(file());
    await removeRunFile(dir, 'abcdefghijklmnopqrstuv');
    expect(await readRunFile(dir, 'abcdefghijklmnopqrstuv')).toBeNull();
  });

  it('an id that is not a session id is never read as a path', async () => {
    expect(await readRunFile(dir, '../../etc/passwd')).toBeNull();
  });

  it('stale run file reads as request_lost', async () => {
    await writeRunFile(dir, file({ pid: DEAD_PID }));
    const f = (await readRunFile(dir, 'abcdefghijklmnopqrstuv'))!;
    expect(await askControl(dir, f, '/result', 0)).toEqual({ status: 'failed', detail: 'request_lost' });
    expect(await readRunFile(dir, 'abcdefghijklmnopqrstuv')).toBeNull();
  });

  it('a live pid whose port refuses also reads as request_lost', async () => {
    await writeRunFile(dir, file({ port: 1 }));
    expect(await askControl(dir, (await readRunFile(dir, 'abcdefghijklmnopqrstuv'))!, '/result', 0)).toEqual({ status: 'failed', detail: 'request_lost' });
  });

  it('listRunning drops stale entries', async () => {
    await writeRunFile(dir, file({ id: 'aaaaaaaaaaaaaaaaaaaaaa' }));
    await writeRunFile(dir, file({ id: 'bbbbbbbbbbbbbbbbbbbbbb', pid: DEAD_PID }));
    fs.writeFileSync(path.join(dir, 'paint.json'), '{}');
    expect((await listRunning(dir)).map((f) => f.id)).toEqual(['aaaaaaaaaaaaaaaaaaaaaa']);
    expect(fs.existsSync(path.join(dir, 'bbbbbbbbbbbbbbbbbbbbbb.json'))).toBe(false);
  });

  it('concurrent claims on one tab yield one request', async () => {
    const [a, b] = await Promise.all([claimTab(dir, 'ws://x|T1'), claimTab(dir, 'ws://x|T1')]);
    const won = [a, b].filter((c) => c.claimed);
    expect(won).toHaveLength(1);
    const winner = won[0] as Extract<typeof a, { claimed: true }>;
    await writeRunFile(dir, file({ id: 'cccccccccccccccccccccc' }));
    await winner.setLockId('cccccccccccccccccccccc');
    const again = await claimTab(dir, 'ws://x|T1');
    expect(again).toEqual({ claimed: false, id: 'cccccccccccccccccccccc' });
    await winner.release();
    expect((await claimTab(dir, 'ws://x|T1')).claimed).toBe(true);
  });

  it('a lock whose request is gone is taken over', async () => {
    const first = await claimTab(dir, 'ws://x|T2');
    if (!first.claimed) throw new Error('expected a claim');
    await first.setLockId('dddddddddddddddddddddd'); // no run file: that request is gone
    expect((await claimTab(dir, 'ws://x|T2')).claimed).toBe(true);
  });

  it('a lock without an id yet is held (the other request is still starting)', async () => {
    const first = await claimTab(dir, 'ws://x|T3');
    expect(first.claimed).toBe(true);
    expect(await claimTab(dir, 'ws://x|T3')).toEqual({ claimed: false, id: null });
  });
});

describe('control endpoint', () => {
  it('binds 127.0.0.1, rejects a wrong token with 401, serves result and cancel', async () => {
    let cancelled = false;
    const srv = await startControlServer({
      token: 'secret-token',
      result: async (maxWaitS) => ({ status: 'waiting', maxWaitS }),
      cancel: async () => ((cancelled = true), { status: 'cancelled' }),
      onRead: () => {},
    });
    try {
      const bad = await fetch(`http://127.0.0.1:${srv.port}/result?max_wait_s=0`, { headers: { authorization: 'Bearer nope' } });
      expect(bad.status).toBe(401);
      const f = file({ port: srv.port, token: 'secret-token' });
      await writeRunFile(dir, f);
      expect(await askControl(dir, f, '/result', 3)).toEqual({ status: 'waiting', maxWaitS: 3 });
      expect(await askControl(dir, f, '/cancel')).toEqual({ status: 'cancelled' });
      expect(cancelled).toBe(true);
      expect((await fetch(`http://127.0.0.1:${srv.port}/other`, { headers: { authorization: 'Bearer secret-token' } })).status).toBe(404);
      expect(srv.host).toBe('127.0.0.1');
    } finally {
      await srv.close();
    }
  });
});
