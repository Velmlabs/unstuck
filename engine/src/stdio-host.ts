import readline from 'node:readline';
import {
  createRpcPeer,
  Methods,
  PROTOCOL_VERSION,
  type HelloParams,
  type HelloResult,
  type TakeoverParams,
} from '@unstuck/protocol';
import { createEngine, type EventLog, type Transport } from '@unstuck/core';
import { createTunneledCdp } from './tunnel';

export interface StdioHostOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  transport: Transport;
  log?: EventLog;
  version: string;
}

/**
 * Serves one SDK over JSON lines. stdout carries only protocol lines.
 * Resolves after `shutdown` or when the SDK closes stdin.
 */
export function runStdioHost(opts: StdioHostOptions): Promise<void> {
  const peer = createRpcPeer((line) => opts.output.write(line + '\n'));
  const engine = createEngine({ transport: opts.transport, log: opts.log });
  const rl = readline.createInterface({ input: opts.input, crlfDelay: Infinity });
  let finished: Promise<void> | null = null;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const finish = () => {
    finished ??= (async () => {
      rl.close();
      await engine.close();
      peer.close('engine shutting down');
      resolveDone();
    })();
    return finished;
  };

  peer.handle(Methods.hello, (raw): HelloResult => {
    const p = raw as HelloParams;
    if (p.protocolVersion !== PROTOCOL_VERSION) {
      throw Object.assign(new Error(`SDK speaks protocol ${p.protocolVersion}, engine speaks ${PROTOCOL_VERSION}`), {
        code: 'protocol_mismatch',
      });
    }
    return { engineVersion: opts.version, protocolVersion: PROTOCOL_VERSION };
  });

  peer.handle(Methods.takeover, (raw) => {
    const p = raw as TakeoverParams;
    return engine.takeover(createTunneledCdp(peer, p.pageId), {
      reason: p.reason,
      timeoutS: p.timeoutS,
      site: p.site,
      onLink: (info) => peer.notify(Methods.takeoverLink, { ...info, pageId: p.pageId }),
    });
  });

  peer.handle(Methods.shutdown, () => {
    // Reply first, then shut down.
    setTimeout(() => void finish(), 0);
    return {};
  });

  rl.on('line', (line) => peer.receive(line));
  rl.on('close', () => void finish());
  return done;
}
