import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { FakeTransport } from '@velmlabs/unstuck-core/testing';
import { connectBrowser, connectCdp } from '../src/direct-cdp';
import { cachedPaintCheck, runRequest } from '../src/shell/request';
import { runCancel, runStart, runWait, type SpawnRequest } from '../src/shell/start';
import type { RequestSpec } from '../src/shell/spec';
import { listRunning, paintCachePath, runDir } from '../src/shell/run-dir';
import { startChromium, type DebugChromium } from './chromium';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/test/fixtures/human-checks');
const INTERSTITIAL = fs.readFileSync(path.join(FIX, 'cloudflare-interstitial.html'), 'utf8');

let chrome: DebugChromium;
let server: http.Server;
let site: string;
let solved = false;
beforeAll(async () => {
  chrome = await startChromium();
  server = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0];
    if (p === '/cf' && !solved) return void res.writeHead(403, { 'content-type': 'text/html' }).end(INTERSTITIAL);
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Shop</title><h1>Shop</h1><p>Welcome, everything is in stock.</p>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await chrome.stop();
  await new Promise((r) => server.close(r));
});

let env: Record<string, string>;
let transport: FakeTransport;
let children: Promise<void>[];
beforeEach(() => {
  env = { UNSTUCK_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-shell-')) };
  transport = new FakeTransport();
  children = [];
  solved = false;
});
afterEach(async () => {
  solved = false;
  for (const f of await listRunning(runDir(env))) await runCancel([f.id], sink().io, env);
  await Promise.all(children);
});

/** The background process, in this process: a FakeTransport the test can join as the person. */
const inProcess =
  (keepMs = 200): SpawnRequest =>
  (spec) =>
    new Promise((resolve) => {
      children.push(runRequest(spec, { transport, env, keepMs }, (r) => resolve('start' in r ? { ready: true, start: r.start } : { ready: false, final: r.final })));
    });

function sink() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (d) => (out += String(d)));
  stderr.on('data', (d) => (err += String(d)));
  return { io: { stdout, stderr }, out: () => out, err: () => err };
}
async function run(fn: (io: ReturnType<typeof sink>['io']) => Promise<number>) {
  const s = sink();
  const code = await fn(s.io);
  return { code, json: s.out() ? JSON.parse(s.out()) : null, out: s.out(), err: s.err() };
}
const start = (kind: 'rescue' | 'takeover' | 'ask', argv: string[], keepMs?: number) => run((io) => runStart(kind, argv, io, env, inProcess(keepMs)));
const wait = (argv: string[]) => run((io) => runWait(argv, io, env));

async function tabs() {
  const b = await connectBrowser(chrome.wsUrl);
  const { targetInfos } = await b.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets');
  await b.close();
  return targetInfos.filter((t) => t.type === 'page');
}
async function goto(p: string): Promise<string> {
  const [tab] = await tabs();
  const cdp = await connectCdp(chrome.wsUrl, { targetId: tab!.targetId });
  await cdp.send('Page.enable');
  const loaded = new Promise((r) => cdp.on('Page.loadEventFired', r));
  await cdp.send('Page.navigate', { url: `${site}${p}` });
  await loaded;
  await cdp.close();
  return tab!.targetId;
}
const person = (link: string) => {
  const v = transport.connect(link);
  v.push({ t: 'hello', token: new URLSearchParams(new URL(link).hash.slice(1)).get('t')! });
  return v;
};

describe('unstuck rescue / takeover / ask / wait / cancel', () => {
  it('rescue on a clear page → exit 0 {status:"clear"} and nothing left running', async () => {
    await goto('/shop');
    const r = await start('rescue', ['--cdp', chrome.wsUrl]);
    expect(r).toMatchObject({ code: 0, json: { status: 'clear' } });
    expect(await listRunning(runDir(env))).toEqual([]);
  });

  it('rescue on a challenge → exit 10 with the link (never a code); the person solves it; wait → resolved', async () => {
    await goto('/cf');
    const r = await start('rescue', ['--cdp', chrome.wsUrl]);
    expect(r.code).toBe(10);
    expect(r.json).toMatchObject({ status: 'human_needed', link: expect.stringContaining('#t='), link_note: expect.any(String), reason: expect.stringContaining('Cloudflare') });
    expect(r.out + r.err).not.toMatch(/\b\d{6}\b/);
    expect((await wait([r.json.id, '--max-wait', '1'])).json).toMatchObject({ status: 'waiting', id: r.json.id });
    const v = person(r.json.link);
    solved = true;
    await goto('/cf'); // Cloudflare reloads into the site once it's solved
    v.push({ t: 'done' });
    const w = await wait([r.json.id, '--max-wait', '30']);
    expect(w).toMatchObject({ code: 0, json: { status: 'resolved', check: { kind: 'challenge', vendor: 'cloudflare' } } });
  }, 60_000);

  it('a second rescue on the same tab returns the same request', async () => {
    await goto('/cf');
    const a = await start('rescue', ['--cdp', chrome.wsUrl]);
    const b = await start('rescue', ['--cdp', chrome.wsUrl]);
    expect(b.code).toBe(10);
    expect(b.json.id).toBe(a.json.id);
  }, 30_000);

  it('the tab closing ends the request failed (page_closed)', async () => {
    const b = await connectBrowser(chrome.wsUrl);
    const { targetId } = await b.send<{ targetId: string }>('Target.createTarget', { url: `${site}/cf` });
    await new Promise((x) => setTimeout(x, 500));
    const r = await start('rescue', ['--cdp', chrome.wsUrl, '--tab', targetId]);
    expect(r.code).toBe(10);
    await b.send('Target.closeTarget', { targetId });
    await b.close();
    const w = await wait([r.json.id, '--max-wait', '20']);
    expect(w).toMatchObject({ code: 30, json: { status: 'failed', detail: 'page_closed' } });
  }, 60_000);

  it('a fourth running request → exit 2 too_many_requests', async () => {
    for (const q of ['One?', 'Two?', 'Three?']) expect((await start('ask', [q])).code).toBe(10);
    const r = await start('ask', ['Four?']);
    expect(r).toMatchObject({ code: 2, json: { error: 'too_many_requests' } });
  }, 30_000);

  it('takeover --reason → human_needed; Done → resolved', async () => {
    await goto('/shop');
    const r = await start('takeover', ['--cdp', chrome.wsUrl, '--reason', 'Log in with your account']);
    expect(r.json).toMatchObject({ status: 'human_needed', reason: 'Log in with your account' });
    person(r.json.link).push({ t: 'done' });
    expect((await wait([r.json.id, '--max-wait', '20'])).json).toMatchObject({ status: 'resolved', check: { kind: 'ask' } });
  }, 30_000);

  it('with Cloud alerts the start reports alerted once the phone accepted it', async () => {
    await goto('/shop');
    const alerter = Object.assign(async () => ({ delivered: 1 }), {}) as never;
    const r = await run((io) =>
      runStart('takeover', ['--cdp', chrome.wsUrl, '--reason', 'Pick a seat'], io, env, (spec) =>
        new Promise((resolve) => {
          children.push(runRequest(spec, { transport, env, keepMs: 200, alerter }, (x) => resolve('start' in x ? { ready: true, start: x.start } : { ready: false, final: x.final })));
        }),
      ),
    );
    expect(r.json).toMatchObject({ status: 'human_needed', alerted: true });
  }, 30_000);

  it('the paint check probes once per browser and is read from the cache afterwards', async () => {
    const dir = runDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const first = await cachedPaintCheck(dir, chrome.wsUrl)();
    expect(typeof first === 'boolean' || first === 'unknown').toBe(true);
    fs.writeFileSync(paintCachePath(dir), JSON.stringify({ [chrome.wsUrl]: 'cached-marker' }));
    expect(await cachedPaintCheck(dir, chrome.wsUrl)()).toBe('cached-marker');
    expect((await tabs()).length).toBe(1); // the probe's background tab is gone
  }, 60_000);

  it('takeover without --reason is exit 2', async () => {
    expect((await start('takeover', ['--cdp', chrome.wsUrl])).code).toBe(2);
  });

  it('ask with choices → human_needed; answered on the page → exit 0 with the label', async () => {
    const r = await start('ask', ['Ship it?', '--choice', 'Yes', '--choice', 'No']);
    expect(r.json).toMatchObject({ status: 'human_needed', reason: 'Ship it?' });
    const v = person(r.json.link);
    await vi.waitFor(() => expect(v.json().some((m: { t: string }) => m.t === 'mode')).toBe(true));
    v.push({ t: 'answer', choice: 0 });
    expect(await wait([r.json.id, '--max-wait', '20'])).toMatchObject({ code: 0, json: { status: 'answered', answer: { choice: 0, label: 'Yes' }, via: 'page' } });
  }, 30_000);

  it('a typed answer carries detail_note', async () => {
    const r = await start('ask', ['Which flight?', '--allow-text']);
    const v = person(r.json.link);
    await vi.waitFor(() => expect(v.json().some((m: { t: string }) => m.t === 'mode')).toBe(true));
    v.push({ t: 'answer', text: 'the cheaper one' });
    expect((await wait([r.json.id, '--max-wait', '20'])).json).toMatchObject({ status: 'answered', answer: { text: 'the cheaper one' }, detail_note: expect.any(String) });
  }, 30_000);

  it('ask validation and usage errors are exit 2', async () => {
    expect((await start('ask', ['Pick', '--choice', 'Only one'])).json.message).toContain('choices must be 2-6 labels');
    expect((await start('ask', [])).code).toBe(2);
    expect((await start('ask', ['Q?', '--timeout', '0'])).code).toBe(2);
    expect((await start('ask', ['Q?', '--alerts', 'maybe'])).code).toBe(2);
  });

  it('cancel ends the request cancelled; wait then answers the same', async () => {
    const r = await start('ask', ['Still there?', '--choice', 'Yes', '--choice', 'No']);
    const c = await run((io) => runCancel([r.json.id], io, env));
    expect(c).toMatchObject({ code: 30, json: { status: 'cancelled' } });
    expect((await wait([r.json.id])).json).toMatchObject({ status: 'cancelled' });
  }, 30_000);

  it('UNSTUCK_REQUIRE_CODE=1 without Cloud, and --alerts required without Cloud, are exit 2', async () => {
    env.UNSTUCK_REQUIRE_CODE = '1';
    expect((await start('ask', ['Q?', '--choice', 'A', '--choice', 'B'])).json).toMatchObject({ error: 'config_error' });
    delete env.UNSTUCK_REQUIRE_CODE;
    expect((await start('ask', ['Q?', '--choice', 'A', '--choice', 'B', '--alerts', 'required'])).json).toMatchObject({ error: 'config_error' });
  });

  it('an id that starts with "-" is still read as the id', async () => {
    expect((await wait(['-abcdefghijklmnopqrstu', '--max-wait', '1'])).json).toMatchObject({ error: 'unknown_request' });
    expect((await run((io) => runCancel(['-abcdefghijklmnopqrstu'], io, env))).json).toMatchObject({ error: 'unknown_request' });
  });

  it('wait and cancel: unknown ids and bad usage are exit 2', async () => {
    expect((await wait(['nonexistentrequestidxx'])).json).toMatchObject({ error: 'unknown_request' });
    expect((await wait([])).code).toBe(2);
    expect((await run((io) => runCancel([], io, env))).code).toBe(2);
    expect((await run((io) => runCancel(['nonexistentrequestidxx'], io, env))).json).toMatchObject({ error: 'unknown_request' });
  });

  it('the background process ends after the result was read and the keep time passed; its run file goes', async () => {
    const r = await start('ask', ['Done soon?', '--choice', 'Yes', '--choice', 'No'], 100);
    const v = person(r.json.link);
    await vi.waitFor(() => expect(v.json().some((m: { t: string }) => m.t === 'mode')).toBe(true));
    v.push({ t: 'answer', choice: 1 });
    expect((await wait([r.json.id, '--max-wait', '20'])).json.status).toBe('answered');
    await Promise.all(children);
    expect(await listRunning(runDir(env))).toEqual([]);
    expect(fs.readdirSync(runDir(env)).filter((n) => n.endsWith('.json') && n !== 'paint.json')).toEqual([]);
  }, 30_000);
});

describe('selfArgs', () => {
  it('runs the compiled engine itself, node plus the script from source, or an explicit entry', async () => {
    const { selfArgs } = await import('../src/shell/start');
    expect(selfArgs({}, '/$bunfs/root/unstuck-engine', '1.4.4')).toEqual([]);
    expect(selfArgs({}, '/repo/engine/dist/cli.js', undefined)).toEqual(['/repo/engine/dist/cli.js']);
    expect(selfArgs({ UNSTUCK_SHELL_ENTRY: '/x/entry.js' }, '/$bunfs/root/a', '1.4.4')).toEqual(['/x/entry.js']);
    expect(selfArgs({}, '', '')).toEqual([]);
  });
});

describe('readSpec', () => {
  it('reads the first line, a line without a newline, and refuses an empty stdin', async () => {
    const { readSpec } = await import('../src/shell/start');
    const one = new PassThrough();
    one.end('{"kind":"ask","profile":"cli"}\n{"ignored":1}\n');
    expect(await readSpec(one)).toEqual({ kind: 'ask', profile: 'cli' });
    const noNl = new PassThrough();
    noNl.end('{"kind":"rescue","profile":"cli"}');
    expect((await readSpec(noNl)).kind).toBe('rescue');
    const empty = new PassThrough();
    empty.end('');
    await expect(readSpec(empty)).rejects.toThrow('no request spec on stdin');
  });
});

describe('runStart flags and the spec it hands the background process', () => {
  const recording = (answer: Record<string, unknown>) => {
    const specs: RequestSpec[] = [];
    const impl: SpawnRequest = async (spec) => (specs.push(spec), answer);
    return { specs, impl };
  };

  it('bad --alerts, --timeout and --max-rescues-per-hour are exit 2 usage', async () => {
    for (const argv of [['--alerts', 'maybe'], ['--timeout', '0'], ['--timeout', '1.5'], ['--max-rescues-per-hour', 'x']]) {
      const r = await run((io) => runStart('takeover', ['--cdp', chrome.wsUrl, '--reason', 'r', ...argv], io, env, recording({}).impl));
      expect([r.code, r.json.error]).toEqual([2, 'usage']);
    }
  });

  it('ask passes allow-text, public, details, timeout, alerts=false and the agent name', async () => {
    const rec = recording({ ready: false, final: { status: 'expired' } });
    const r = await run((io) => runStart('ask', ['Which seat?', '--allow-text', '--public', '--details', 'Row 3 or 4', '--timeout', '120', '--alerts', 'false', '--agent-name', 'Trip bot'], io, env, rec.impl));
    expect(r.code).toBe(30);
    expect(r.json).toEqual({ status: 'expired' });
    expect(rec.specs[0]).toMatchObject({ kind: 'ask', timeoutS: 120, alerts: false, agentName: 'Trip bot', ask: { question: 'Which seat?', allowText: true, private: false, details: 'Row 3 or 4' } });
  });

  it('takeover passes profile and max rescues; a start that ended reports its final result', async () => {
    await goto('/shop');
    const rec = recording({ ready: false, final: { status: 'failed', detail: 'page_closed' } });
    const r = await run((io) => runStart('takeover', ['--cdp', chrome.wsUrl, '--reason', 'r', '--profile', 'work', '--max-rescues-per-hour', '4', '--alerts', 'true'], io, env, rec.impl));
    expect([r.code, r.json]).toEqual([30, { status: 'failed', detail: 'page_closed' }]);
    expect(rec.specs[0]).toMatchObject({ kind: 'takeover', profile: 'work', maxRescuesPerHour: 4, alerts: true, site: '127.0.0.1' });
  });

  it('a question the engine refuses ends the request failed before any link', async () => {
    const got = await new Promise<unknown>((resolve) => {
      children.push(runRequest({ kind: 'ask', profile: 'cli', ask: { question: '', private: true } }, { transport, env }, resolve));
    });
    expect(got).toMatchObject({ final: { status: 'failed', detail: expect.any(String) } });
  });

  it('a background process that answered neither is failed start_failed', async () => {
    const r = await run((io) => runStart('ask', ['Ok?'], io, env, async () => ({ ready: false })));
    expect([r.code, r.json]).toEqual([30, { status: 'failed', detail: 'start_failed' }]);
  });

  it('another start still under way on the same tab is exit 2 busy', async () => {
    await goto('/shop');
    let release!: () => void;
    const slow: SpawnRequest = () => new Promise((r) => (release = () => r({ ready: false, final: { status: 'expired' } })));
    const first = run((io) => runStart('takeover', ['--cdp', chrome.wsUrl, '--reason', 'r'], io, env, slow));
    await expect.poll(() => fs.readdirSync(runDir(env)).filter((n) => n.endsWith('.lock')).length).toBe(1);
    const second = await run((io) => runStart('takeover', ['--cdp', chrome.wsUrl, '--reason', 'r'], io, env, slow));
    expect([second.code, second.json.error]).toEqual([2, 'busy']);
    release();
    await first;
  }, 30_000);
});
