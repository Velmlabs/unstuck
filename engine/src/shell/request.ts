// The background process of one shell request (`unstuck-engine __request`): it holds the tab, the session and the
// alert, serves `wait`/`cancel` on its loopback control endpoint, keeps the final result for a while, then exits.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  createEngine,
  createFileSessionStore,
  createRateLimiter,
  onceRenderCheck,
  profileFile,
  rescue,
  sendAskAlert,
  sendTakeoverAlert,
  type AlertOutcome,
  type CloudAlerter,
  type LinkInfo,
  type RenderCheck,
  type TakeoverControl,
  type Transport,
} from '@velmlabs/unstuck-core';
import type { AskResult, HumanCheck, RescueOutcome } from '@velmlabs/unstuck-protocol';
import { connectBrowser, connectCdp, type DirectCdp } from '../direct-cdp';
import { probeCaptchaPaint } from '../browser/paint-check';
import { nodeStoreFs, unstuckHome } from '../browser/node-store-fs';
import { DETAIL_NOTE, LINK_NOTE } from '../mcp';
import { markEnded, nameTabLock, paintCachePath, releaseTab, releaseTabIf, removeRunFile, runDir, startControlServer, writeRunFile } from './run-dir';
import { ALERT_WAIT_MS_DEFAULT, REQUEST_START_LIMIT_MS, type RequestSpec } from './spec';

/** How long a finished result stays readable by `wait`: after its first read, or after the end if nobody reads it. */
export const FINISHED_KEEP_MS = 10 * 60_000;

export interface RequestDeps {
  transport: Transport;
  alerter?: CloudAlerter;
  env: Record<string, string | undefined>;
  keepMs?: number;
  /** How long making the link may take (default REQUEST_START_LIMIT_MS). */
  startTimeoutMs?: number;
  /** Called once everything is closed (the process entry exits there). */
  onExit?: () => void;
}

export type Final = Record<string, unknown> & { status: string };

/** A rescue's final result, as the MCP browsing tools report it (no cookies, no code). */
export function rescueResult(o: RescueOutcome): Final {
  const typed = o.status === 'cancelled' && !!o.detail && o.detail !== 'cant_solve' && o.detail !== 'cancelled_by_agent';
  return {
    status: o.status,
    check: { kind: o.check.kind, ...(o.check.vendor ? { vendor: o.check.vendor } : {}), site: o.check.site },
    waited_s: o.waitedS,
    ...(o.detail ? { detail: o.detail } : {}),
    ...(typed ? { detail_note: DETAIL_NOTE } : {}),
  };
}

/** A question's final result. */
export function askResult(r: AskResult): Final {
  if (r.status !== 'answered') return { status: r.status, ...(r.detail ? { detail: r.detail } : {}) };
  const answer = r.answer ?? {};
  return { status: 'answered', answer, ...(r.via ? { via: r.via } : {}), ...(answer.text ? { detail_note: DETAIL_NOTE } : {}) };
}

/** The start result a shell agent shows the person: the link, never the code. */
export function startResult(info: LinkInfo, alert: AlertOutcome | undefined): Record<string, unknown> {
  return {
    status: 'human_needed',
    id: info.sessionId,
    link: info.url,
    link_note: LINK_NOTE,
    ...(info.code ? { code_required: true } : {}),
    expires_in_s: Math.max(0, Math.round((info.expiresAt - Date.now()) / 1000)),
    reason: info.reason,
    ...(alert ? { alerted: alert.delivered > 0 } : {}),
  };
}

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    void p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(undefined)),
    );
  });

/** Resolves when `done` settles, `ms` passes or `signal` aborts, whichever is first; leaves no timer or listener. */
export function untilDone(done: Promise<unknown>, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const t = setTimeout(finish, ms);
    signal.addEventListener('abort', finish);
    void done.then(finish, finish);
  });
}

/** Why a request ended before its link, as a detail code (never a raw error message). */
function startFailure(e: unknown): string {
  const m = (e as Error)?.message ?? '';
  if (m === 'start_timeout') return m;
  if (/could not reach the browser|ECONNREFUSED|fetch failed/i.test(m)) return 'browser_unreachable';
  if (/target .* not found|no page target|No target with given id/i.test(m)) return 'page_closed';
  return 'start_failed';
}

/** The paint check, cached per browser in the run directory; its probe tab opens in the background. */
export function cachedPaintCheck(dir: string, browserWsUrl: string): RenderCheck {
  return onceRenderCheck(async () => {
    const file = paintCachePath(dir);
    const cache = JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) as Record<string, boolean | 'unknown'>;
    if (browserWsUrl in cache) return cache[browserWsUrl]!;
    const paint = await probeCaptchaPaint(async (url) => {
      const b = await connectBrowser(browserWsUrl);
      const { targetId } = await b.send<{ targetId: string }>('Target.createTarget', { url, background: true });
      await b.close();
      const tab = await connectCdp(browserWsUrl, { targetId });
      return {
        cdp: tab,
        close: async () => {
          await tab.browser.send('Target.closeTarget', { targetId }).catch(() => {});
          await tab.close();
        },
      };
    });
    if (paint !== 'unknown') await writeFile(file, JSON.stringify({ ...cache, [browserWsUrl]: paint }), { mode: 0o600 });
    return paint;
  });
}

/**
 * Runs one request. `ready` is called once: with the start result when the link exists (after waiting up to
 * ALERT_WAIT_MS for the phone alert), or with the final result when it ended before any link (e.g. rescue_limited,
 * browser_cannot_render_captcha). Resolves once everything is closed.
 */
export async function runRequest(spec: RequestSpec, d: RequestDeps, ready: (r: { start: Record<string, unknown> } | { final: Final }) => void): Promise<void> {
  const env = d.env;
  const dir = runDir(env);
  const keepMs = d.keepMs ?? FINISHED_KEEP_MS;
  const engine = createEngine({ transport: d.transport, requireCode: env.UNSTUCK_REQUIRE_CODE === '1' });
  let cdp: DirectCdp | null = null;
  let control: TakeoverControl | null = null;
  let resolveLink!: (v: { info: LinkInfo; alert: Promise<AlertOutcome> | null }) => void;
  const linked = new Promise<{ info: LinkInfo; alert: Promise<AlertOutcome> | null }>((r) => (resolveLink = r));
  const onLink = (info: LinkInfo, takeover: TakeoverControl) => {
    control = takeover;
    const alert = spec.kind === 'ask' ? sendAskAlert(d.alerter, spec.alerts, info, takeover, spec.ask!) : sendTakeoverAlert(d.alerter, spec.alerts, info, spec.site, takeover);
    resolveLink({ info, alert });
  };

  const locks = [spec.tabKey, spec.slotKey].filter((k): k is string => !!k);
  /** With `id`, the tab's lock is freed only while it still names this request (a newer one may hold the tab). */
  const closeAll = async (id?: string) => {
    for (const key of locks) await (id ? releaseTabIf(dir, key, id) : releaseTab(dir, key));
    await engine.close().catch(() => {});
    await cdp?.close().catch(() => {});
  };

  // Making the link (connecting to the tab included) has a time limit of its own.
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  const tooSlow = new Promise<'timeout'>((r) => (startTimer = setTimeout(() => r('timeout'), d.startTimeoutMs ?? REQUEST_START_LIMIT_MS)));
  const inTime = <T>(p: Promise<T>): Promise<T> => Promise.race([p, tooSlow.then((): never => { throw new Error('start_timeout'); })]);

  let finalP: Promise<Final>;
  try {
    if (spec.kind === 'ask') {
      const a = spec.ask!;
      finalP = engine
        .ask({
          question: a.question,
          ...(a.choices ? { choices: a.choices } : {}),
          ...(a.allowText !== undefined ? { allowText: a.allowText } : {}),
          private: a.private,
          ...(a.details ? { details: a.details } : {}),
          ...(spec.timeoutS ? { timeoutS: spec.timeoutS } : {}),
          ...(spec.agentName ? { agentName: spec.agentName } : {}),
          onLink,
        })
        .then(askResult);
    } else {
      const page = (cdp = await inTime(connectCdp(spec.browserWsUrl!, { targetId: spec.targetId! })));
      const limiter = createRateLimiter(createFileSessionStore(nodeStoreFs(), profileFile(unstuckHome(env), spec.profile)), { maxPerHour: spec.maxRescuesPerHour });
      const check: HumanCheck = spec.check ?? { kind: 'ask', ruleId: 'ask', evidence: [], url: spec.pageUrl ?? '', site: spec.site ?? '' };
      finalP = rescue(page, check, {
        limiter,
        profile: spec.profile,
        ...(spec.scope ? { scope: spec.scope } : {}),
        ...(spec.reason ? { reason: spec.reason } : {}),
        canRenderCaptcha: cachedPaintCheck(dir, spec.browserWsUrl!),
        takeover: (o) =>
          engine.takeover(page, {
            reason: o.reason,
            site: o.site,
            kind: o.kind,
            ...(o.mode ? { mode: o.mode } : {}),
            ...((o.timeoutS ?? spec.timeoutS) ? { timeoutS: o.timeoutS ?? spec.timeoutS } : {}),
            ...(spec.agentName ? { agentName: spec.agentName } : {}),
            onLink,
            popups: page.popups,
          }),
      }).then(rescueResult);
    }
  } catch (e) {
    clearTimeout(startTimer);
    ready({ final: { status: 'failed', detail: startFailure(e) } });
    await closeAll();
    return d.onExit?.();
  }

  let final: Final | null = null;
  const done = finalP.then(
    (f) => (final = f),
    (e: Error) => (final = { status: 'failed', detail: e.message }),
  );
  const first = await Promise.race([linked, done.then(() => null), tooSlow]);
  clearTimeout(startTimer);
  if (first === 'timeout') {
    ready({ final: { status: 'failed', detail: 'start_timeout' } });
    await closeAll();
    return d.onExit?.();
  }
  if (!first) {
    ready({ final: final! });
    await closeAll();
    return d.onExit?.();
  }

  const { info, alert } = first;
  const start = startResult(info, alert ? await within(alert, ALERT_WAIT_MS_DEFAULT) : undefined);
  const token = randomBytes(32).toString('base64url');
  let finished!: () => void;
  const allClosed = new Promise<void>((r) => (finished = r));
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleExit = () => {
    if (exitTimer) clearTimeout(exitTimer);
    exitTimer = setTimeout(() => void cleanup(), keepMs);
  };
  const waiting = () => ({ status: 'waiting', id: info.sessionId, joined: control?.joined() ?? false, expires_in_s: Math.max(0, Math.round((info.expiresAt - Date.now()) / 1000)) });
  const server = await startControlServer({
    token,
    onRead: () => {},
    result: async (maxWaitS, signal) => {
      if (!final) await untilDone(done, maxWaitS * 1000, signal);
      if (!final) return waiting();
      scheduleExit();
      return final;
    },
    cancel: async () => {
      control?.cancel('cancelled_by_agent');
      await done;
      scheduleExit();
      return final!;
    },
  });
  // Never longer than keepMs past the request's own expiry, read or not.
  const hardStop = setTimeout(() => void cleanup(), Math.max(0, info.expiresAt - Date.now()) + keepMs);
  await writeRunFile(dir, {
    id: info.sessionId,
    pid: process.pid,
    port: server.port,
    token,
    kind: spec.kind,
    ...(spec.tabKey ? { tab: spec.tabKey } : {}),
    ...(spec.browserWsUrl ? { browser: spec.browserWsUrl } : {}),
    startedAt: Date.now(),
    expiresAt: info.expiresAt,
    start,
  });
  // This process names the request in the tab's lock before reporting, so a concurrent start finds it.
  for (const key of locks) await nameTabLock(dir, key, info.sessionId);
  // At the end the tab and the running slot are free at once; the result stays readable for keepMs (read or not).
  void done.then(async () => {
    await markEnded(dir, info.sessionId);
    for (const key of locks) await releaseTabIf(dir, key, info.sessionId);
    scheduleExit();
  });
  ready({ start });

  let cleaning = false;
  async function cleanup(): Promise<void> {
    if (cleaning) return;
    cleaning = true;
    clearTimeout(hardStop);
    if (exitTimer) clearTimeout(exitTimer);
    control?.cancel('engine_closed');
    await server.close().catch(() => {});
    await removeRunFile(dir, info.sessionId);
    await closeAll(info.sessionId);
    finished();
  }
  await allClosed;
  d.onExit?.();
}
