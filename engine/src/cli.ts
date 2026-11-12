import { parseArgs } from 'node:util';
import { createEmbeddedTransport, type AssetMap } from './embedded';
import { runStdioHost } from './stdio-host';
import { JsonlFileEventLog, defaultLogPath } from './jsonl-log';
import { VERSION } from './version';

export const USAGE = `Usage: unstuck-engine --stdio [--host <host>] [--port <port>]
       unstuck-engine --version | --help

Runs the Unstuck engine for one SDK process over JSON lines on stdin/stdout.
The viewer is served on 127.0.0.1 by default (UNSTUCK_HOST, UNSTUCK_PORT,
UNSTUCK_PUBLIC_URL and UNSTUCK_LOG override defaults).
`;

export interface CliIO {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: { write(s: string): unknown };
  env: Record<string, string | undefined>;
  assets: AssetMap;
}

/** Returns the process exit code. */
export async function main(argv: string[], io: CliIO): Promise<number> {
  let values: { stdio?: boolean; version?: boolean; help?: boolean; host?: string; port?: string };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { stdio: { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean' }, host: { type: 'string' }, port: { type: 'string' } },
      strict: true,
    }));
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
  const port = values.port === undefined ? undefined : Number(values.port);
  if (!values.stdio || (port !== undefined && !Number.isInteger(port))) {
    io.stderr.write(USAGE);
    return 2;
  }
  const warn = (m: string) => io.stderr.write(`[unstuck] ${m}\n`);
  let transport;
  try {
    transport = await createEmbeddedTransport({ assets: io.assets, host: values.host, port, env: io.env, warn });
  } catch (e) {
    io.stderr.write(`[unstuck] could not start the viewer server: ${(e as Error).message}\n`);
    return 1;
  }
  io.stderr.write(`[unstuck] engine ${VERSION}; viewer server listening on http://${transport.host}:${transport.port}\n`);
  await runStdioHost({ input: io.stdin, output: io.stdout, transport, log: new JsonlFileEventLog(defaultLogPath(io.env)), version: VERSION });
  return 0;
}
