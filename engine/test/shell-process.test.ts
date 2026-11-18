// The process edges of the shell commands: starting the background process, the background process's own entry,
// and the result shapes it reports.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { askResult, rescueResult, startResult, untilDone } from '../src/shell/request';
import { runRequestChild, selfArgs, spawnRequest, tabKeyFor } from '../src/shell/start';
import { ShellError } from '../src/shell/tab';
import type { RequestSpec } from '../src/shell/spec';

const SPEC: RequestSpec = { kind: 'takeover', profile: 'cli', reason: 'r' };

/** A stand-in background process: node runs it with `__request` and the spec on stdin. */
function entry(body: string): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-entry-'));
  const file = path.join(dir, 'entry.cjs');
  fs.writeFileSync(file, body);
  return { UNSTUCK_SHELL_ENTRY: file };
}

describe('spawnRequest', () => {
  it('hands the spec to `__request` on stdin and resolves with its first JSON line', async () => {
    const env = entry(`let s='';process.stdin.on('data',d=>{s+=d;if(s.includes('\\n')){process.stdout.write(JSON.stringify({ready:true,arg:process.argv[2],spec:JSON.parse(s)})+'\\n');setTimeout(()=>{},300);}});`);
    expect(await spawnRequest(SPEC, env)).toEqual({ ready: true, arg: '__request', spec: SPEC });
  });

  it('a process that exits before answering is start_failed', async () => {
    const e = await spawnRequest(SPEC, entry('process.exit(3)')).catch((x: unknown) => x as ShellError);
    expect(e).toBeInstanceOf(ShellError);
    expect((e as ShellError).code).toBe('start_failed');
    expect((e as Error).message).toContain('exited (3)');
  });

  it('an unreadable answer is start_failed', async () => {
    const e = await spawnRequest(SPEC, entry(`process.stdout.write('not json\\n');setTimeout(()=>{},300);`)).catch((x: unknown) => x as ShellError);
    expect((e as ShellError).code).toBe('start_failed');
    expect((e as Error).message).toContain('unreadable');
  });
});

describe('runRequestChild', () => {
  it('reports a request that ends before any link as ready:false with the final result', async () => {
    const stdin = new PassThrough();
    let out = '';
    const spec: RequestSpec = { ...SPEC, relay: 'http://127.0.0.1:9', agentKey: 'k', browserWsUrl: 'ws://127.0.0.1:9/devtools/browser/x', targetId: 'x' };
    stdin.end(JSON.stringify(spec) + '\n');
    let exited = false;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-child-'));
    const code = await runRequestChild({ stdin, stdout: { write: (s: string) => (out += s) }, env: { UNSTUCK_HOME: home, UNSTUCK_SHELL_KEEP_MS: '100' }, assets: {} as never }, () => (exited = true));
    expect(code).toBe(0);
    expect(exited).toBe(true);
    expect(JSON.parse(out)).toMatchObject({ ready: false, final: { status: 'failed' } });
  });
});

describe('result shapes', () => {
  const check = { kind: 'challenge', vendor: 'cloudflare', site: 'shop.example', ruleId: 'x', evidence: [], url: 'https://shop.example' } as const;

  it('rescue: no vendor key without a vendor; a typed cancel reason carries detail_note; cant_solve does not', () => {
    expect(rescueResult({ status: 'resolved', check: { ...check, vendor: undefined }, waitedS: 3 } as never)).toEqual({ status: 'resolved', check: { kind: 'challenge', site: 'shop.example' }, waited_s: 3 });
    expect(rescueResult({ status: 'cancelled', check, waitedS: 1, detail: 'the code is on my other phone' } as never)).toMatchObject({ detail: 'the code is on my other phone', detail_note: expect.any(String) });
    expect(rescueResult({ status: 'cancelled', check, waitedS: 1, detail: 'cant_solve' } as never)).not.toHaveProperty('detail_note');
  });

  it('ask: not answered keeps only status and detail; an answer without text has no detail_note', () => {
    expect(askResult({ status: 'expired' } as never)).toEqual({ status: 'expired' });
    expect(askResult({ status: 'cancelled', detail: 'cancelled_by_agent' } as never)).toEqual({ status: 'cancelled', detail: 'cancelled_by_agent' });
    expect(askResult({ status: 'answered', answer: { choice: 'Yes' }, via: 'telegram' } as never)).toEqual({ status: 'answered', answer: { choice: 'Yes' }, via: 'telegram' });
    expect(askResult({ status: 'answered' } as never)).toEqual({ status: 'answered', answer: {} });
  });

  it('start: code_required instead of the code; alerted only when an alert was tried; never a negative expiry', () => {
    const info = { sessionId: 'S', url: 'https://v/x', code: '123456', expiresAt: Date.now() - 5000, reason: 'r' } as never;
    const s = startResult(info, { delivered: 0 } as never);
    expect(s).toMatchObject({ code_required: true, alerted: false, expires_in_s: 0 });
    expect(JSON.stringify(s)).not.toContain('123456');
    expect(startResult({ ...(info as object), code: undefined } as never, undefined)).not.toHaveProperty('alerted');
  });
});

describe('shell details', () => {
  it('one tab is one key however the DevTools address is spelled', () => {
    const a = tabKeyFor('ws://localhost:9222/devtools/browser/0b5e-41', 'T1');
    expect(tabKeyFor('ws://127.0.0.1:9222/devtools/browser/0b5e-41', 'T1')).toBe(a);
    expect(tabKeyFor('ws://127.0.0.1:9222/devtools/browser/0b5e-41', 'T2')).not.toBe(a);
    expect(tabKeyFor('ws://127.0.0.1:9333/devtools/browser/other', 'T1')).not.toBe(a);
  });

  it('a wait leaves no timer or listener behind once it returns', async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const done = new Promise<void>((r) => (finish = r));
      const ac = new AbortController();
      const w = untilDone(done, 60_000, ac.signal);
      finish();
      await w;
      expect(vi.getTimerCount()).toBe(0);
      const w2 = untilDone(new Promise<void>(() => {}), 60_000, ac.signal);
      ac.abort();
      await w2;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('from source, the background process gets the same node flags (e.g. a TypeScript loader)', () => {
    expect(selfArgs({}, '/repo/engine/src/bin.ts', undefined, ['--import', 'tsx'])).toEqual(['--import', 'tsx', '/repo/engine/src/bin.ts']);
    expect(selfArgs({}, '/$bunfs/root/unstuck-engine', '1.4.4', ['--x'])).toEqual([]);
  });
});
