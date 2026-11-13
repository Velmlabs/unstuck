import path from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { createKeyAuthorizer } from '@unstuck/relay-core';
import { createNodeRelay, type NodeRelay } from './server';

const USAGE = `Usage: unstuck-relay [--port 8787] [--host 0.0.0.0]

Environment:
  UNSTUCK_AGENT_KEYS   comma-separated agent keys allowed to register sessions
  UNSTUCK_RELAY_OPEN   set to 1 to accept any agent (local testing only)
  PORT                 port, when --port isn't given
  UNSTUCK_TRUST_PROXY  set to 1 to take client IPs from X-Forwarded-For
`;
const OPEN_WARNING = 'relay is OPEN: anyone can register sessions (UNSTUCK_RELAY_OPEN=1); use UNSTUCK_AGENT_KEYS in production';

export const defaultViewerDir = () => path.join(path.dirname(createRequire(import.meta.url).resolve('@unstuck/viewer/package.json')), 'dist');

/** Returns an exit code, or the running relay. */
export async function main(argv: string[], env: Record<string, string | undefined>, io: { stderr: { write(s: string): unknown } }): Promise<number | NodeRelay> {
  let values: { port?: string; host?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { port: { type: 'string' }, host: { type: 'string' } }, strict: true }));
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const port = Number(values.port ?? env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0) {
    io.stderr.write(USAGE);
    return 2;
  }
  const keys = (env.UNSTUCK_AGENT_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  const open = env.UNSTUCK_RELAY_OPEN === '1';
  if (!keys.length && !open) {
    io.stderr.write(`[unstuck-relay] set UNSTUCK_AGENT_KEYS (or UNSTUCK_RELAY_OPEN=1 for local testing)\n${USAGE}`);
    return 2;
  }
  const warn = () => io.stderr.write(`[unstuck-relay] ${OPEN_WARNING}\n`);
  if (open) warn();
  const relay = await createNodeRelay({
    port,
    host: values.host ?? '0.0.0.0',
    viewerDir: env.UNSTUCK_VIEWER_DIR ?? defaultViewerDir(),
    authorize: createKeyAuthorizer(open ? { open: true } : { keys }),
    onEvent: (e) => void io.stderr.write(JSON.stringify(e) + '\n'),
    trustProxy: env.UNSTUCK_TRUST_PROXY === '1',
    onAgent: open ? warn : undefined,
  });
  io.stderr.write(`[unstuck-relay] listening on http://${values.host ?? '0.0.0.0'}:${relay.port}\n`);
  return relay;
}
