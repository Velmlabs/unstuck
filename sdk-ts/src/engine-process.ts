import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { createRpcPeer, Methods, PROTOCOL_VERSION, RpcCallError, type HelloResult, type RpcPeer } from '@velmlabs/unstuck-protocol';
import { UnstuckEngineError } from './errors';
import { VERSION } from './version';

const requireFromHere = createRequire(import.meta.url);

type Resolver = { resolve: (id: string) => string };

/**
 * Resolves a module the way @velmlabs/unstuck-engine sees it: the platform packages are its optional dependencies, which
 * strict layouts (pnpm, Yarn PnP) don't expose to the SDK itself. Falls back to resolving from the SDK.
 */
export function resolveViaEngine(id: string, base: Resolver = requireFromHere, make: (from: string) => Resolver = createRequire): string {
  try {
    return make(base.resolve('@velmlabs/unstuck-engine/package.json')).resolve(id);
  } catch {
    return base.resolve(id);
  }
}

/** Engine binary lookup: explicit option → UNSTUCK_ENGINE_PATH → @velmlabs/unstuck-engine-<platform>-<arch> package. */
export function resolveEnginePath(
  opts: { enginePath?: string },
  env: Record<string, string | undefined> = process.env,
  resolve: (id: string) => string = (id) => resolveViaEngine(id),
): string {
  if (opts.enginePath) return opts.enginePath;
  if (env.UNSTUCK_ENGINE_PATH) return env.UNSTUCK_ENGINE_PATH;
  const pkg = `@velmlabs/unstuck-engine-${process.platform}-${process.arch}`;
  const bin = `${pkg}/bin/unstuck-engine${process.platform === 'win32' ? '.exe' : ''}`;
  try {
    return resolve(bin);
  } catch {
    throw new UnstuckEngineError(
      `Unstuck engine not found. Tried: the enginePath option, UNSTUCK_ENGINE_PATH, and the package ${pkg}. ` +
        `Reinstall @velmlabs/unstuck without skipping optional dependencies, or set UNSTUCK_ENGINE_PATH to the unstuck-engine binary.`,
    );
  }
}

export interface EngineProcess {
  peer: RpcPeer;
  engineVersion: string;
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>;
  /** Keeps the agent process alive while a takeover runs; let it exit otherwise. */
  setBusy(busy: boolean): void;
  kill(): void;
}

const HINT = 'Set UNSTUCK_ENGINE_PATH to a working unstuck-engine binary.';
export const HANDSHAKE_TIMEOUT_MS = 15_000;

export async function spawnEngine(
  path: string,
  opts: { host?: string; port?: number; relay?: string; agentKey?: string; handshakeTimeoutMs?: number },
): Promise<EngineProcess> {
  const args = ['--stdio'];
  if (opts.host) args.push('--host', opts.host);
  if (opts.port !== undefined) args.push('--port', String(opts.port));
  // Relay mode is chosen by the engine from its environment (relay spec §5.6).
  const env = { ...process.env, ...(opts.relay ? { UNSTUCK_RELAY_URL: opts.relay } : {}), ...(opts.agentKey ? { UNSTUCK_AGENT_KEY: opts.agentKey } : {}) };
  const child = spawn(path, args, { stdio: ['pipe', 'pipe', 'inherit'], env });
  const peer = createRpcPeer((line) => {
    if (child.stdin.writable) child.stdin.write(line + '\n');
  });
  child.stdin.on('error', () => {});
  readline.createInterface({ input: child.stdout }).on('line', (l) => peer.receive(l));

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      peer.close(`engine exited with code ${code}`);
      resolve(code);
    });
  });
  const spawnError = new Promise<never>((_, reject) =>
    child.once('error', (e) =>
      reject(new UnstuckEngineError(`could not start the Unstuck engine at ${path}: ${e.message}. ${HINT}`, path)),
    ),
  );
  const earlyExit = exited.then((code): never => {
    throw new UnstuckEngineError(`the Unstuck engine at ${path} exited with code ${code} before the handshake. ${HINT}`, path);
  });
  const timeoutMs = opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  const handshakeTimeout = new Promise<never>((_, reject) => {
    handshakeTimer = setTimeout(
      () => reject(new UnstuckEngineError(`the Unstuck engine at ${path} did not answer the handshake within ${timeoutMs / 1000} s. ${HINT}`, path)),
      timeoutMs,
    );
  });
  const handles = [child, child.stdin, child.stdout] as unknown as { ref(): void; unref(): void }[];
  const setBusy = (busy: boolean) => handles.forEach((h) => (busy ? h.ref() : h.unref()));

  let hello: HelloResult;
  try {
    hello = await Promise.race([
      peer.request<HelloResult>(Methods.hello, { sdk: 'ts', sdkVersion: VERSION, protocolVersion: PROTOCOL_VERSION }),
      spawnError,
      earlyExit,
      handshakeTimeout,
    ]);
  } catch (e) {
    child.kill();
    if (e instanceof UnstuckEngineError) throw e;
    if (e instanceof RpcCallError && e.code === 'closed') {
      throw new UnstuckEngineError(`the Unstuck engine at ${path} exited with code ${await exited} before the handshake. ${HINT}`, path);
    }
    throw new UnstuckEngineError(`the Unstuck engine at ${path} refused the handshake: ${(e as Error).message}. ${HINT}`, path);
  } finally {
    clearTimeout(handshakeTimer);
    handshakeTimeout.catch(() => {});
    earlyExit.catch(() => {});
    spawnError.catch(() => {});
  }
  setBusy(false);
  return { peer, engineVersion: hello.engineVersion, exited, setBusy, kill: () => child.kill() };
}
