import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createNodeRelay } from '@velmlabs/unstuck-relay';
import { createKeyAuthorizer, type OnEvent } from '@velmlabs/unstuck-relay-core';
import type { CdpClient } from '@velmlabs/unstuck-core';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RELAY_KEY = 'e2e-relay-key';

/** Ports this process has handed out: two callers never get the same one, even before either has bound it. */
const handedOut = new Set<number>();

/**
 * A port nothing listens on right now. Another process can still take it before the caller binds it, so whatever binds
 * it must be started through a retry (startOnFreePort, launchWithCdpPort) rather than trusted to win the race.
 */
export async function freePort(): Promise<number> {
  for (;;) {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise((r) => srv.close(r));
    if (handedOut.has(port)) continue;
    handedOut.add(port);
    return port;
  }
}

/** Polls `${url}/healthz` until it answers 200; `label` names what failed to start. */
export async function waitHealthy(url: string, ms: number, label = 'relay') {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if ((await fetch(`${url}/healthz`)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`${label} at ${url} did not start`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Process groups started here (detached children): killed if this process exits or is interrupted (Ctrl-C) first. */
const groups = new Set<number>();
let guarded = false;
function guardGroups() {
  if (guarded) return;
  guarded = true;
  const killAll = () => {
    for (const pid of groups) killGroup(pid, 'SIGKILL');
    groups.clear();
  };
  process.once('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(sig, () => {
      killAll();
      process.kill(process.pid, sig); // then the signal's usual effect (this listener is gone now)
    });
}

function killGroup(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig);
  } catch {
    // the group is already gone
  }
}

/** Whether any process of the group is still alive (the leader may have exited while its children live on). */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Spawns `cmd` as the leader of its own process group, which stopGroup (or this process exiting) ends as a whole. */
export function spawnGroup(cmd: string, args: string[], opts: Omit<SpawnOptions, 'detached'>): ChildProcess {
  guardGroups();
  const child = spawn(cmd, args, { ...opts, detached: true });
  if (child.pid) groups.add(child.pid);
  return child;
}

/**
 * Stops a detached child's whole process group: SIGTERM, then SIGKILL if any of it is still alive after `ms`. It waits
 * for the group, not the leader: `npx` can exit while the wrangler and workerd under it keep running. Never throws.
 */
export async function stopGroup(child: ChildProcess, ms = 5_000): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const gone = async (within: number) => {
    const end = Date.now() + within;
    while (groupAlive(pid)) {
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  };
  if (groupAlive(pid)) {
    killGroup(pid, 'SIGTERM');
    if (!(await gone(ms))) {
      killGroup(pid, 'SIGKILL');
      await gone(1_000);
    }
  }
  groups.delete(pid);
}

/**
 * Starts a server on a free port and waits for its /healthz. If it exits first (typically: another process took the
 * port between freePort and the bind), it is retried on a new port, up to `attempts` times.
 */
export async function startOnFreePort(
  label: string,
  start: (port: number) => ChildProcess,
  { attempts = 3, ms = 90_000 }: { attempts?: number; ms?: number } = {},
): Promise<{ child: ChildProcess; port: number; url: string }> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const child = start(port);
    const url = `http://127.0.0.1:${port}`;
    // A spawn error (e.g. no wrangler binary) or an early exit ends the wait at once instead of after the deadline.
    const died = new Promise<never>((_, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`${label} exited (${code ?? signal})`)));
    });
    died.catch(() => {});
    try {
      await Promise.race([waitHealthy(url, ms, label), died]);
      return { child, port, url };
    } catch (e) {
      await stopGroup(child);
      const early = child.exitCode !== null || child.signalCode !== null;
      if (!early || attempt >= attempts) throw e;
    }
  }
}

/**
 * Launches Chromium with its DevTools HTTP endpoint on a free port, retrying on another port if that one turns out to
 * belong to someone else (a different browser version, or no DevTools answer at all).
 */
export async function launchWithCdpPort(chromium: any, attempts = 3): Promise<{ browser: any; port: number }> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    try {
      const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { Browser?: string; webSocketDebuggerUrl?: string };
      if (v.webSocketDebuggerUrl && v.Browser?.endsWith(`/${browser.version()}`)) return { browser, port };
    } catch {
      // not ours
    }
    await browser.close();
    if (attempt >= attempts) throw new Error(`Chromium's DevTools endpoint did not come up on a free port (${attempts} tries)`);
  }
}

/** The start page's button: Start takeover, Answer (a question) or Open (an approval). */
const START = /^(Start takeover|Answer|Open)$/;
/** Taps Start on a takeover link (the page connects only then), waiting for the button to appear. */
export async function tapStart(p: { getByRole: (role: 'button', o: { name: string | RegExp }) => { waitFor: (o: { timeout: number }) => Promise<void>; click: () => Promise<void> } }) {
  const b = p.getByRole('button', { name: START });
  await b.waitFor({ timeout: 5_000 });
  await b.click();
}

/**
 * Starts a relay that accepts RELAY_KEY: the Node relay in-process, or the Cloudflare relay under `wrangler dev`. The Node
 * relay reports its events (billing among them) to `onEvent`.
 */
export async function startRelay(kind: 'node' | 'cloudflare', o: { onEvent?: OnEvent } = {}): Promise<{ url: string; stop(): Promise<void> }> {
  if (kind === 'node') {
    const viewerDir = path.join(path.dirname(createRequire(import.meta.url).resolve('@velmlabs/unstuck-viewer/package.json')), 'dist');
    const r = await createNodeRelay({ port: 0, host: '127.0.0.1', viewerDir, authorize: createKeyAuthorizer({ keys: [RELAY_KEY] }), ...(o.onEvent ? { onEvent: o.onEvent } : {}) });
    return { url: `ws://127.0.0.1:${r.port}`, stop: () => r.close() };
  }
  const dir = path.join(here, '../relay-cloudflare');
  await new Promise<void>((resolve, reject) => {
    const copy = spawn('node', ['scripts/copy-viewer.mjs'], { cwd: dir, stdio: 'ignore' });
    copy.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('copy-viewer failed'))));
  });
  const log = process.env.RELAY_LOG ? 'inherit' : 'ignore';
  const { child, port } = await startOnFreePort('relay-cloudflare', (port) =>
    spawnGroup(
      'npx',
      ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--var', `AGENT_KEYS:${RELAY_KEY}`, '--persist-to', path.join(dir, '.wrangler/e2e')],
      { cwd: dir, stdio: ['ignore', log, log], env: { ...process.env, CI: '1' } },
    ),
  );
  return { url: `ws://127.0.0.1:${port}`, stop: () => stopGroup(child) };
}

/** A Playwright page as the engine's CdpClient, for in-process mode (no engine binary). */
export async function cdpFor(page: any): Promise<CdpClient> {
  const s = await page.context().newCDPSession(page);
  return {
    send: (method, params) => s.send(method, params),
    on(event, handler) {
      s.on(event, handler);
      return () => s.off(event, handler);
    },
    onClose(handler) {
      const h = () => handler('page closed');
      page.once('close', h);
      return () => page.off('close', h);
    },
  };
}
