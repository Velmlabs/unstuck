// `unstuck rescue | takeover | ask` (start a request in a background process and return its link at once),
// `unstuck wait <id>` and `unstuck cancel <id>`, and the background process's entry (`__request`).
import { spawn as nodeSpawn } from 'node:child_process';
import readline from 'node:readline';
import { checkAsk, cleanAgentName, detectHumanCheck } from '@velmlabs/unstuck-core';
import { connectCdp } from '../direct-cdp';
import { createEmbeddedTransport, type AssetMap } from '../embedded';
import { buildTransport } from '../transport-select';
import { cloudAlerterFor } from '../cli';
import { REQUIRED_WITHOUT_CLOUD } from '../guard-host';
import { cdpUrlFrom, parseShell, rescueScope } from './args';
import { usageError } from './check';
import { EXIT, emit, exitFor } from './output';
import { runRequest } from './request';
import { askControl, claimTab, readRunFile, runDir, type TabClaim } from './run-dir';
import { type RequestSpec } from './spec';
import { ShellError, resolveTab } from './tab';

/** At most this many requests run at once (MCP's MAX_ACTIVE_TAKEOVERS). */
export const MAX_RUNNING = 3;
export const DEFAULT_MAX_WAIT_S = 45;
export const MAX_WAIT_S = 120;
/** How long a start waits for its background process to report the link. */
export const START_TIMEOUT_MS = 30_000;

interface IO {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

/** Starts the background process with the spec; resolves with its first JSON line. Tests replace it. */
export type SpawnRequest = (spec: RequestSpec, env: Record<string, string | undefined>) => Promise<Record<string, unknown>>;

/**
 * How to run this same program again: the released engine is a single compiled executable (process.execPath is the
 * engine itself; Bun puts a virtual /$bunfs path in argv[1]), while from source it is node plus a script.
 */
export function selfArgs(
  env: Record<string, string | undefined>,
  argv1: string | undefined = process.argv[1],
  bun: string | undefined = process.versions.bun,
  execArgv: string[] = process.execArgv,
): string[] {
  if (env.UNSTUCK_SHELL_ENTRY) return [env.UNSTUCK_SHELL_ENTRY];
  if (bun && (argv1 ?? '').includes('$bunfs')) return [];
  return argv1 ? [...execArgv, argv1] : [];
}

/** The default: this same program, detached, `__request`, spec on stdin, one JSON line back on stdout. */
export const spawnRequest: SpawnRequest = (spec, env) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(process.execPath, [...selfArgs(env), '__request'], { detached: true, stdio: ['pipe', 'pipe', 'ignore'], env: env as NodeJS.ProcessEnv });
    const timer = setTimeout(() => {
      child.kill();
      reject(new ShellError('start_failed', undefined, 'the background process did not report a link in time'));
    }, START_TIMEOUT_MS);
    child.once('error', (e) => (clearTimeout(timer), reject(new ShellError('start_failed', undefined, e.message))));
    readline.createInterface({ input: child.stdout! }).once('line', (line) => {
      clearTimeout(timer);
      child.stdout!.destroy();
      child.unref();
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        reject(new ShellError('start_failed', undefined, 'the background process answered with something unreadable'));
      }
    });
    child.once('exit', (code) => (clearTimeout(timer), reject(new ShellError('start_failed', undefined, `the background process exited (${code}) before reporting a link`))));
    child.stdin!.end(JSON.stringify(spec) + '\n');
  });

const SHARED = {
  timeout: { type: 'string' },
  alerts: { type: 'string' },
  'agent-name': { type: 'string' },
  relay: { type: 'string' },
  'agent-key': { type: 'string' },
} as const;
const TAB = { cdp: { type: 'string' }, tab: { type: 'string' }, profile: { type: 'string' }, 'max-rescues-per-hour': { type: 'string' } } as const;

const positiveInt = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ShellError('usage', undefined, `--${name} must be a whole number of at least 1`);
  return n;
};

function alertsFlag(v: string | undefined): boolean | 'required' {
  if (v === undefined || v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'required') return 'required';
  throw new ShellError('usage', undefined, '--alerts must be true, false or required');
}

/** `rescue`, `takeover` and `ask`: validates, starts the background process, and prints its link (or its result). */
export async function runStart(kind: 'rescue' | 'takeover' | 'ask', argv: string[], io: IO, env: Record<string, string | undefined>, spawnImpl: SpawnRequest = spawnRequest): Promise<number> {
  let release: (() => Promise<void>) | null = null;
  try {
    const options =
      kind === 'ask'
        ? { ...SHARED, choice: { type: 'string', multiple: true }, 'allow-text': { type: 'boolean' }, public: { type: 'boolean' }, details: { type: 'string' } }
        : { ...SHARED, ...TAB, reason: { type: 'string' }, ...(kind === 'rescue' ? { url: { type: 'string' }, rescue: { type: 'string' } } : {}) };
    const { values, positionals } = parseShell(argv, options as never, kind === 'ask');
    const v = values as Record<string, string | boolean | string[] | undefined>;
    const alerts = alertsFlag(v.alerts as string | undefined);
    const timeoutS = positiveInt('timeout', v.timeout as string | undefined);
    const relay = v.relay as string | undefined;
    const agentKey = v['agent-key'] as string | undefined;
    const alerter = cloudAlerterFor({ relay, agentKey }, env, () => {});
    if (alerts === 'required' && !alerter) throw new ShellError('config_error', undefined, REQUIRED_WITHOUT_CLOUD);
    if (env.UNSTUCK_REQUIRE_CODE === '1' && !alerter) throw new ShellError('config_error', undefined, 'a 6-digit code needs Unstuck Cloud phone alerts (UNSTUCK_API_KEY)');
    const agentName = cleanAgentName((v['agent-name'] as string | undefined) ?? env.UNSTUCK_AGENT_NAME);
    const dir = runDir(env);
    const base = { timeoutS, alerts, ...(agentName ? { agentName } : {}), ...(relay ? { relay } : {}), ...(agentKey ? { agentKey } : {}), profile: 'cli' };

    let spec: RequestSpec;
    if (kind === 'ask') {
      if (positionals.length !== 1) throw new ShellError('usage', undefined, 'ask takes one question: unstuck ask "Which flight?" --choice A --choice B');
      const ask = {
        question: positionals[0]!,
        ...(v.choice ? { choices: v.choice as string[] } : {}),
        ...(v['allow-text'] ? { allowText: true } : {}),
        private: !v.public,
        ...(v.details ? { details: v.details as string } : {}),
      };
      const problem = checkAsk({ ...ask, ...(timeoutS ? { timeoutS } : {}) });
      if (problem) throw new ShellError('usage', undefined, problem);
      const slot = await claimSlot(dir);
      release = slot.release;
      spec = { ...base, kind, ask, slotKey: slot.key };
    } else {
      if (kind === 'takeover' && !v.reason) throw new ShellError('usage', undefined, 'takeover needs --reason "<what the person should do>"');
      const scope = kind === 'rescue' ? rescueScope(v.rescue as string | undefined) : undefined;
      const profile = (v.profile as string | undefined) ?? 'cli';
      const maxRescuesPerHour = positiveInt('max-rescues-per-hour', v['max-rescues-per-hour'] as string | undefined);
      const tab = await resolveTab(cdpUrlFrom(v.cdp as string | undefined, env), v.tab as string | undefined);
      const tabKey = tabKeyFor(tab.browserWsUrl, tab.targetId);
      const claim = await claimOrJoin(dir, tabKey);
      if (!claim.claimed) {
        const current = claim.id ? await readRunFile(dir, claim.id) : null;
        if (current?.start) return emit(io, current.start, EXIT.humanNeeded, 'A person is already being asked about this tab: show them the link, then run unstuck wait.');
        throw new ShellError('busy', undefined, 'another request for this tab is starting: try again in a moment');
      }
      const slot = await claimSlot(dir).catch(async (e: unknown) => {
        await claim.release();
        throw e;
      });
      release = () => Promise.all([claim.release(), slot.release()]).then(() => {});
      let check;
      if (kind === 'rescue') {
        const cdp = await connectCdp(tab.browserWsUrl, { targetId: tab.targetId });
        try {
          check = await detectHumanCheck(cdp, { scope: scope!, ...(v.url ? { requestedUrl: v.url as string } : {}) });
        } finally {
          await cdp.close();
        }
        if (!check) {
          await release();
          release = null;
          return emit(io, { status: 'clear' }, EXIT.done);
        }
      }
      spec = {
        ...base,
        kind,
        profile,
        ...(maxRescuesPerHour ? { maxRescuesPerHour } : {}),
        browserWsUrl: tab.browserWsUrl,
        targetId: tab.targetId,
        tabKey,
        slotKey: slot.key,
        pageUrl: tab.url,
        site: check?.site ?? siteOfUrl(tab.url),
        ...(check ? { check } : {}),
        ...(scope ? { scope } : {}),
        ...(v.reason ? { reason: v.reason as string } : {}),
      };
      // From here the background process owns the tab's lock: it names it before reporting and frees it at the end.
      const r = await spawnImpl(spec, env);
      release = null;
      return report(io, r);
    }
    const r = await spawnImpl(spec, env);
    release = null; // the background process owns the slot now
    return report(io, r);
  } catch (e) {
    if (release) await release();
    return usageError(io, e);
  }
}

/**
 * One tab, whatever the DevTools address looked like (localhost or 127.0.0.1): the browser's port and id plus the
 * tab's targetId.
 */
export function tabKeyFor(browserWsUrl: string, targetId: string): string {
  try {
    const u = new URL(browserWsUrl);
    const id = /\/devtools\/browser\/([^/?#]+)/.exec(u.pathname)?.[1];
    if (id) return `browser:${u.port}/${id}|${targetId}`;
  } catch {
    /* not a URL: use it as given */
  }
  return `${browserWsUrl}|${targetId}`;
}

/** A running slot (MAX_RUNNING of them, held like a tab lock until the request ends), or too_many_requests. */
async function claimSlot(dir: string): Promise<{ key: string; release(): Promise<void> }> {
  for (let n = 0; n < MAX_RUNNING; n++) {
    const key = `slot:${n}`;
    const c = await claimTab(dir, key);
    if (c.claimed) return { key, release: c.release };
  }
  throw new ShellError('too_many_requests', undefined, 'finish or cancel a request first');
}

/**
 * Claims the tab, or, while another start on it is still under way, waits for that start to name its request (so
 * both callers get the same link). Gives up after START_TIMEOUT_MS with the last answer.
 */
async function claimOrJoin(dir: string, tabKey: string): Promise<TabClaim> {
  const until = Date.now() + START_TIMEOUT_MS;
  let claim = await claimTab(dir, tabKey);
  while (!claim.claimed && claim.id === null && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    claim = await claimTab(dir, tabKey);
  }
  // A named lock always has its run file (and start) already: the request's process writes it before naming the lock.
  return claim;
}

function report(io: IO, r: Record<string, unknown>): number {
  if (r.ready) return emit(io, r.start as Record<string, unknown>, EXIT.humanNeeded, 'Show the person the link (and only them), then run unstuck wait <id>.');
  const final = (r.final ?? { status: 'failed', detail: String(r.error ?? 'start_failed') }) as Record<string, unknown> & { status: string };
  return emit(io, final, exitFor(final.status));
}

function siteOfUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * The request id and the remaining flags. Ids are base64url and may start with "-", which a flag parser would read as
 * an option, so the first argument is the id whenever it looks like one.
 */
function idAndFlags(argv: string[]): { id: string | undefined; rest: string[] } {
  if (argv[0] !== undefined && REQUEST_ID.test(argv[0])) return { id: argv[0], rest: argv.slice(1) };
  return { id: undefined, rest: argv };
}

/** `unstuck wait <id> [--max-wait <s>]`: the result, or `waiting` after max-wait seconds (default 45, at most 120). */
export async function runWait(argv: string[], io: IO, env: Record<string, string | undefined>): Promise<number> {
  try {
    const { id, rest } = idAndFlags(argv);
    const { values } = parseShell(rest, { 'max-wait': { type: 'string' } });
    if (!id) throw new ShellError('usage', undefined, 'wait takes the request id: unstuck wait <id>');
    const maxWait = Math.min(MAX_WAIT_S, positiveInt('max-wait', values['max-wait']) ?? DEFAULT_MAX_WAIT_S);
    const dir = runDir(env);
    const f = await readRunFile(dir, id);
    if (!f) throw new ShellError('unknown_request', undefined, `no running request ${id} (it ended more than 10 minutes ago, or never started)`);
    const r = await askControl(dir, f, '/result', maxWait);
    return emit(io, r, exitFor(String(r.status)));
  } catch (e) {
    return usageError(io, e);
  }
}

/** `unstuck cancel <id>`: ends the request; prints its final result. */
export async function runCancel(argv: string[], io: IO, env: Record<string, string | undefined>): Promise<number> {
  try {
    const { id, rest } = idAndFlags(argv);
    parseShell(rest, {});
    if (!id) throw new ShellError('usage', undefined, 'cancel takes the request id: unstuck cancel <id>');
    const dir = runDir(env);
    const f = await readRunFile(dir, id);
    if (!f) throw new ShellError('unknown_request', undefined, `no running request ${id}`);
    const r = await askControl(dir, f, '/cancel');
    return emit(io, r, exitFor(String(r.status)));
  } catch (e) {
    return usageError(io, e);
  }
}

/** Reads the spec (one JSON line) from `input`. */
export async function readSpec(input: NodeJS.ReadableStream): Promise<RequestSpec> {
  let buf = '';
  for await (const chunk of input) {
    buf += String(chunk);
    const nl = buf.indexOf('\n');
    if (nl >= 0) return JSON.parse(buf.slice(0, nl)) as RequestSpec;
  }
  if (!buf.trim()) throw new Error('no request spec on stdin');
  return JSON.parse(buf) as RequestSpec;
}

/** The background process (`unstuck-engine __request`): runs the request, reports once on stdout, then lives on. */
export async function runRequestChild(io: { stdin: NodeJS.ReadableStream; stdout: { write(s: string): unknown }; env: Record<string, string | undefined>; assets: AssetMap }, onExit?: () => void): Promise<number> {
  const spec = await readSpec(io.stdin);
  const env = io.env;
  const relay = buildTransport({ relay: spec.relay, agentKey: spec.agentKey }, env, { write: () => true });
  const transport = relay?.transport ?? (await createEmbeddedTransport({ assets: io.assets, env, warn: () => {} }));
  const alerter = cloudAlerterFor({ relay: spec.relay, agentKey: spec.agentKey, agentName: spec.agentName }, env, () => {});
  const keepMs = env.UNSTUCK_SHELL_KEEP_MS ? Number(env.UNSTUCK_SHELL_KEEP_MS) : undefined;
  await runRequest(spec, { transport, ...(alerter ? { alerter } : {}), env, ...(keepMs ? { keepMs } : {}), ...(onExit ? { onExit } : {}) }, (r) => {
    io.stdout.write(JSON.stringify('start' in r ? { ready: true, start: r.start } : { ready: false, final: r.final }) + '\n');
  });
  return 0;
}
