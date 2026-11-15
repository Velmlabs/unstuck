import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createNodeRelay } from '@velmlabs/unstuck-relay';
import { createKeyAuthorizer } from '@velmlabs/unstuck-relay-core';
import type { CdpClient } from '@velmlabs/unstuck-core';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RELAY_KEY = 'e2e-relay-key';

export async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
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

/** Stops a detached child's process group: SIGTERM, then SIGKILL if it hasn't exited within `ms`. Never throws. */
export async function stopGroup(child: ChildProcess, ms = 5_000): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  const kill = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      // the group is already gone
    }
  };
  kill('SIGTERM');
  const timer = new Promise<'late'>((r) => setTimeout(() => r('late'), ms).unref());
  if ((await Promise.race([exited, timer])) === 'late') {
    kill('SIGKILL');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1_000).unref())]);
  }
}

/** Taps Start on a takeover link (the page connects only then), waiting for the button to appear. */
export async function tapStart(p: { getByRole: (role: 'button', o: { name: string }) => { waitFor: (o: { timeout: number }) => Promise<void>; click: () => Promise<void> } }) {
  const b = p.getByRole('button', { name: 'Start takeover' });
  await b.waitFor({ timeout: 5_000 });
  await b.click();
}

/** Starts a relay that accepts RELAY_KEY: the Node relay in-process, or the Cloudflare relay under `wrangler dev`. */
export async function startRelay(kind: 'node' | 'cloudflare'): Promise<{ url: string; stop(): Promise<void> }> {
  if (kind === 'node') {
    const viewerDir = path.join(path.dirname(createRequire(import.meta.url).resolve('@velmlabs/unstuck-viewer/package.json')), 'dist');
    const r = await createNodeRelay({ port: 0, host: '127.0.0.1', viewerDir, authorize: createKeyAuthorizer({ keys: [RELAY_KEY] }) });
    return { url: `ws://127.0.0.1:${r.port}`, stop: () => r.close() };
  }
  const dir = path.join(here, '../relay-cloudflare');
  const port = await freePort();
  await new Promise<void>((resolve, reject) => {
    const copy = spawn('node', ['scripts/copy-viewer.mjs'], { cwd: dir, stdio: 'ignore' });
    copy.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('copy-viewer failed'))));
  });
  const child = spawn(
    'npx',
    ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--var', `AGENT_KEYS:${RELAY_KEY}`, '--persist-to', path.join(dir, '.wrangler/e2e')],
    { cwd: dir, stdio: ['ignore', process.env.RELAY_LOG ? 'inherit' : 'ignore', process.env.RELAY_LOG ? 'inherit' : 'ignore'], detached: true, env: { ...process.env, CI: '1' } },
  );
  const spawnFailed = new Promise<never>((_, reject) => child.once('error', reject));
  spawnFailed.catch(() => {});
  try {
    await Promise.race([waitHealthy(`http://127.0.0.1:${port}`, 90_000, 'relay-cloudflare'), spawnFailed]);
  } catch (e) {
    await stopGroup(child);
    throw e;
  }
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
