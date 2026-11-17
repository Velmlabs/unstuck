import { parseArgs } from 'node:util';
import { createEmbeddedTransport, type AssetMap } from './embedded';
import { runStdioHost } from './stdio-host';
import { JsonlFileEventLog, defaultLogPath } from './jsonl-log';
import { VERSION } from './version';
import fs from 'node:fs';
import path from 'node:path';
import { createMcpServer, TOOL_NAMES } from './mcp';
import { BROWSE_TOOL_NAMES } from './mcp-browse';
import type { BrowseConfig } from './browser/session';
import { OBSCURA_NOT_FOUND } from './browser/launcher';
import { unstuckHome } from './browser/node-store-fs';
import { PROFILE_NAME } from '@velmlabs/unstuck-core';
import { formatReport, runDoctor } from './doctor';
import { buildTransport, cloudAlertsFor, selectTransport } from './transport-select';
import { createCloudAlerter } from './cloud-alerts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Readable, Writable } from 'node:stream';

export const USAGE = `Usage: unstuck-engine --stdio [--host <host>] [--port <port>] [--relay <wss://…> [--agent-key <key>]]
       unstuck-engine --mcp [--open] [--host <host>] [--port <port>] [--relay <wss://…> [--agent-key <key>]]
                     [--browser[=chrome|obscura] [--obscura-path <path>] | --tools takeover|browser]
                     [--profile <name>] [--no-remember] [--max-rescues-per-hour <n>]
       unstuck-engine doctor --cdp <url>
       unstuck-engine --version | --help

--mcp runs an MCP server on stdin/stdout. Tools: request_human_takeover (one
      step: blocks until the human is done) and start_human_takeover,
      wait_for_human_takeover, cancel_human_takeover (two steps: the agent gets
      the link at once to show in the chat). The browser comes from the tool's
      cdp_url or UNSTUCK_CDP_URL; --open opens each takeover link in this
      machine's browser.
--browser (Unstuck Browser) also adds fetch_page, get_session, forget_site,
      remember_site and resume_after_human, on a headless Chrome or Chromium
      Unstuck starts when first needed (--browser=obscura: Obscura). A human
      check on a page brings a person in. --tools browser adds the same tools
      on the browser at UNSTUCK_CDP_URL instead. Remembered sites live in
      ~/.unstuck/profiles/<profile> (--profile, default mcp; --no-remember
      keeps nothing); at most --max-rescues-per-hour person-checks (default 10).
      A browsing tool waits UNSTUCK_IN_TOOL_WAIT_S (default 40) for a person
      before it returns the link; keep it under your client's tool timeout.
doctor checks a browser (live view, input, paste, cross-origin iframes, popups)
      in a tab of its own and prints whether Unstuck works fully with it.

Runs the Unstuck engine for one SDK process over JSON lines on stdin/stdout.
The viewer is served on 127.0.0.1 by default (UNSTUCK_HOST, UNSTUCK_PORT,
UNSTUCK_PUBLIC_URL and UNSTUCK_LOG override defaults).

Relay mode: --relay/--agent-key, else UNSTUCK_RELAY_URL + UNSTUCK_AGENT_KEY, else
UNSTUCK_API_KEY (Unstuck Cloud, wss://relay.unstuck.sh). UNSTUCK_REQUIRE_CODE=1 asks
humans for a 6-digit code sent with the link.
`;

const OPTIONS = {
  cdp: { type: 'string' },
  stdio: { type: 'boolean' },
  mcp: { type: 'boolean' },
  open: { type: 'boolean' },
  version: { type: 'boolean' },
  help: { type: 'boolean' },
  host: { type: 'string' },
  port: { type: 'string' },
  relay: { type: 'string' },
  'agent-key': { type: 'string' },
  browser: { type: 'string' },
  'obscura-path': { type: 'string' },
  tools: { type: 'string' },
  profile: { type: 'string' },
  'no-remember': { type: 'boolean' },
  'max-rescues-per-hour': { type: 'string' },
} as const;

/** parseArgs, with a bare `--browser` read as `--browser=chrome`. */
function parse(argv: string[]) {
  return parseArgs({ args: argv.map((a) => (a === '--browser' ? '--browser=chrome' : a)), allowPositionals: true, options: OPTIONS, strict: true });
}

const BROWSE_FLAGS = ['browser', 'obscura-path', 'tools', 'profile', 'no-remember', 'max-rescues-per-hour'] as const;

/** `obscura` on PATH, if there is one. */
function onPath(name: string, env: Record<string, string | undefined>): string | undefined {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** The Unstuck Browser options the flags ask for: `{}` for the takeover tools only, or the usage error. */
export function browseConfig(argv: string[], env: Record<string, string | undefined>): { browse?: BrowseConfig; error?: string } {
  let values: ReturnType<typeof parse>['values'];
  try {
    ({ values } = parse(argv));
  } catch (e) {
    return { error: (e as Error).message };
  }
  const used = BROWSE_FLAGS.filter((f) => values[f] !== undefined);
  if (used.length === 0) return {};
  if (!values.mcp) return { error: `--${used[0]} needs --mcp` };
  if (values.tools !== undefined && values.tools !== 'takeover' && values.tools !== 'browser') return { error: '--tools is takeover or browser' };
  if (values.browser !== undefined && values.browser !== 'chrome' && values.browser !== 'obscura') return { error: '--browser is chrome or obscura' };
  if (values.tools === 'takeover') {
    if (used.length > 1) return { error: `--tools takeover has no browser: drop ${used.filter((f) => f !== 'tools').map((f) => `--${f}`).join(', ')}` };
    return {};
  }
  let source: BrowseConfig['source'];
  if (values.browser === 'obscura') {
    const p = values['obscura-path'] ?? env.OBSCURA_PATH ?? onPath('obscura', env);
    if (!p) return { error: OBSCURA_NOT_FOUND };
    source = { kind: 'obscura', path: p };
  } else if (values.browser === 'chrome') source = { kind: 'chrome' };
  else if (values.tools === 'browser') {
    if (!env.UNSTUCK_CDP_URL) return { error: '--tools browser wraps the browser at UNSTUCK_CDP_URL; set it, or use --browser to let Unstuck start its own' };
    source = { kind: 'cdp', url: env.UNSTUCK_CDP_URL };
  } else return { error: `--${used[0]} needs --browser or --tools browser` };
  const profile = values.profile ?? 'mcp';
  if (!PROFILE_NAME.test(profile)) return { error: 'profile names are letters, digits, "-" and "_" (at most 64), e.g. "mcp"' };
  const max = values['max-rescues-per-hour'] === undefined ? 10 : Number(values['max-rescues-per-hour']);
  if (!Number.isInteger(max) || max < 1) return { error: '--max-rescues-per-hour is a whole number of at least 1' };
  let inToolWaitMs: number | undefined;
  if (env.UNSTUCK_IN_TOOL_WAIT_S !== undefined) {
    const w = Number(env.UNSTUCK_IN_TOOL_WAIT_S);
    // Under 120 s: the default MCP client tool timeout is 60 s, and some raise it to 120 s.
    if (!Number.isInteger(w) || w < 1 || w > 110) return { error: 'UNSTUCK_IN_TOOL_WAIT_S is a whole number of seconds from 1 to 110' };
    inToolWaitMs = w * 1000;
  }
  return { browse: { source, profile, remember: !values['no-remember'], maxRescuesPerHour: max, home: unstuckHome(env), ...(inToolWaitMs ? { inToolWaitMs } : {}) } };
}

export interface CliIO {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: { write(s: string): unknown };
  env: Record<string, string | undefined>;
  assets: AssetMap;
}

/** Returns the process exit code. */
export async function main(argv: string[], io: CliIO): Promise<number> {
  let positionals: string[];
  let values: ReturnType<typeof parse>['values'];
  try {
    ({ values, positionals } = parse(argv));
  } catch (e) {
    io.stderr.write(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help) {
    io.stdout.write(USAGE);
    return 0;
  }
  if (positionals[0] === 'doctor') {
    if (!values.cdp || positionals.length > 1) {
      io.stderr.write(USAGE);
      return 2;
    }
    try {
      const report = await runDoctor(values.cdp);
      io.stdout.write(formatReport(report));
      return report.verdict === 'unsupported' ? 1 : 0;
    } catch (e) {
      io.stderr.write(`[unstuck] doctor: ${(e as Error).message}\n`);
      return 1;
    }
  }
  if (positionals.length > 0 || values.cdp) {
    io.stderr.write(USAGE);
    return 2;
  }
  const port = values.port === undefined ? undefined : Number(values.port);
  const modes = Number(!!values.stdio) + Number(!!values.mcp);
  if (modes !== 1 || (values.open && !values.mcp) || (port !== undefined && !Number.isInteger(port))) {
    io.stderr.write(USAGE);
    return 2;
  }
  const browsing = browseConfig(argv, io.env);
  if (browsing.error) {
    io.stderr.write(`${browsing.error}\n${USAGE}`);
    return 2;
  }
  const warn = (m: string) => io.stderr.write(`[unstuck] ${m}\n`);
  const requireCode = io.env.UNSTUCK_REQUIRE_CODE === '1';
  let transport;
  const relay = buildTransport({ relay: values.relay, agentKey: values['agent-key'] }, io.env, io.stderr);
  if (relay) {
    transport = relay.transport;
    io.stderr.write(`[unstuck] engine ${VERSION}; ${relay.description}\n`);
  } else {
    try {
      const embedded = await createEmbeddedTransport({ assets: io.assets, host: values.host, port, env: io.env, warn });
      transport = embedded;
      io.stderr.write(`[unstuck] engine ${VERSION}; viewer server listening on http://${embedded.host}:${embedded.port}\n`);
    } catch (e) {
      io.stderr.write(`[unstuck] could not start the viewer server: ${(e as Error).message}\n`);
      return 1;
    }
  }
  const cloud = cloudAlertsFor(selectTransport({ relay: values.relay, agentKey: values['agent-key'] }, io.env), io.env);
  const alerter = cloud ? createCloudAlerter({ ...cloud, log: (l) => void io.stderr.write(l + '\n') }) : undefined;
  if (values.mcp) {
    const server = createMcpServer({ transport, log: new JsonlFileEventLog(defaultLogPath(io.env)), env: io.env, stderr: io.stderr, open: values.open, alerter, ...(browsing.browse ? { browse: browsing.browse } : {}) });
    const closed = new Promise<void>((r) => io.stdin.once('end', () => r()));
    await server.connect(new StdioServerTransport(io.stdin as Readable, io.stdout as Writable));
    const tools = [...TOOL_NAMES, ...(browsing.browse ? BROWSE_TOOL_NAMES : [])];
    io.stderr.write(`[unstuck] MCP server ready (tools: ${tools.join(', ')})\n`);
    await closed;
    await server.close();
    return 0;
  }
  await runStdioHost({ input: io.stdin, output: io.stdout, transport, log: new JsonlFileEventLog(defaultLogPath(io.env)), version: VERSION, requireCode, alerter });
  return 0;
}
