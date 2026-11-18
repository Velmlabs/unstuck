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

describe('tab claims and control failures', () => {
  it('a claim names its request, and release frees the tab', async () => {
    const c = await claimTab(dir, 'T9');
    if (!c.claimed) throw new Error('not claimed');
    await writeRunFile(dir, file({ id: 'idforthelockxxxxxxxxx', tab: 'T9' }));
    await c.setLockId('idforthelockxxxxxxxxx');
    expect(await claimTab(dir, 'T9')).toEqual({ claimed: false, id: 'idforthelockxxxxxxxxx' });
    await c.release();
    expect((await claimTab(dir, 'T9')).claimed).toBe(true);
  });

  it('a lock with no id older than the start grace is taken over', async () => {
    const c = await claimTab(dir, 'T8');
    expect(c.claimed).toBe(true);
    const lock = fs.readdirSync(dir).find((n) => n.endsWith('.lock'))!;
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(path.join(dir, lock), old, old);
    expect((await claimTab(dir, 'T8')).claimed).toBe(true);
  });

  it('a handler that throws answers 500 with status failed', async () => {
    const srv = await startControlServer({
      token: 'tok',
      result: async () => {
        throw new Error('boom');
      },
      cancel: async () => {
        throw new Error('bang');
      },
      onRead: () => {},
    });
    try {
      const h = { authorization: 'Bearer tok' };
      const r = await fetch(`http://127.0.0.1:${srv.port}/result`, { headers: h });
      expect([r.status, await r.json()]).toEqual([500, { status: 'failed', detail: 'boom' }]);
      const c = await fetch(`http://127.0.0.1:${srv.port}/cancel`, { method: 'POST', headers: h });
      expect([c.status, await c.json()]).toEqual([500, { status: 'failed', detail: 'bang' }]);
      expect((await fetch(`http://127.0.0.1:${srv.port}/result`)).status).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it('many shells taking over one stale lock at once: exactly one wins', async () => {
    for (let round = 0; round < 5; round++) {
      const key = `STALE${round}`;
      const c = await claimTab(dir, key);
      if (!c.claimed) throw new Error('setup');
      await c.setLockId('deadrequestidxxxxxxxxx'); // its run file doesn't exist: stale
      const claims = await Promise.all(Array.from({ length: 12 }, () => claimTab(dir, key)));
      expect(claims.filter((x) => x.claimed).length, `round ${round}`).toBe(1);
    }
  });

  it('a lock naming a request that has ended (kept only for wait) is taken over', async () => {
    const c = await claimTab(dir, 'T7');
    if (!c.claimed) throw new Error('setup');
    await writeRunFile(dir, file({ id: 'endedrequestidxxxxxxx', tab: 'T7', endedAt: Date.now() }));
    await c.setLockId('endedrequestidxxxxxxx');
    expect((await claimTab(dir, 'T7')).claimed).toBe(true);
  });

  it('a takeover marker left by a shell that died mid-takeover is cleared, then the stale lock is taken', async () => {
    const c = await claimTab(dir, 'T6');
    if (!c.claimed) throw new Error('setup');
    await c.setLockId('deadrequestidxxxxxxxxx');
    const lock = fs.readdirSync(dir).find((n) => n.endsWith('.lock'))!;
    const marker = path.join(dir, `${lock}.takeover`);
    fs.writeFileSync(marker, '');
    expect(await claimTab(dir, 'T6')).toEqual({ claimed: false, id: null }); // a fresh marker: someone is on it
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(marker, old, old);
    expect(await claimTab(dir, 'T6')).toEqual({ claimed: false, id: null }); // the dead shell's marker goes
    expect(fs.existsSync(marker)).toBe(false);
    expect((await claimTab(dir, 'T6')).claimed).toBe(true);
  });
});
