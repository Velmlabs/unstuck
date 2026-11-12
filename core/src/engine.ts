import type { TakeoverResult } from '@unstuck/protocol';
import type { CdpClient } from './cdp';
import type { EventLog } from './events';
import type { Transport } from './transport';
import { importSecret, newSecret } from './session/tokens';
import { runTakeover, type LinkInfo, type RunningTakeover } from './session/takeover';

export type { LinkInfo } from './session/takeover';
export type LinkHandler = (info: LinkInfo) => void;

export interface EngineOptions {
  transport: Transport;
  log?: EventLog;
  secret?: Uint8Array;
  now?: () => number;
  defaultTimeoutS?: number;
  onLink?: LinkHandler;
}

export interface TakeoverCallOptions {
  reason: string;
  timeoutS?: number;
  site?: string;
  onLink?: LinkHandler;
}

export interface Engine {
  /** Never rejects: every failure becomes a TakeoverResult. */
  takeover(cdp: CdpClient, opts: TakeoverCallOptions): Promise<TakeoverResult>;
  /** Cancels in-flight takeovers (detail `engine_closed`) and closes the transport. */
  close(): Promise<void>;
}

export const DEFAULT_TIMEOUT_S = 600;

export function createEngine(opts: EngineOptions): Engine {
  const key = importSecret(opts.secret ?? newSecret());
  const now = opts.now ?? (() => Date.now());
  const running = new Set<RunningTakeover>();

  return {
    async takeover(cdp, call) {
      // Subscribe before any await so a page that closes during setup is not missed.
      let closedBefore: string | undefined;
      const off = cdp.onClose((reason) => (closedBefore ??= reason));
      const k = await key;
      off();
      const session = runTakeover({ transport: opts.transport, key: k, log: opts.log, now }, cdp, {
        closedBefore,
        reason: call.reason,
        timeoutS: call.timeoutS ?? opts.defaultTimeoutS ?? DEFAULT_TIMEOUT_S,
        site: call.site,
        onLink: call.onLink ?? opts.onLink,
      });
      running.add(session);
      try {
        return await session.result;
      } finally {
        running.delete(session);
      }
    },
    async close() {
      const results = [...running].map((s) => {
        s.cancel('engine_closed');
        return s.result;
      });
      await Promise.all(results);
      await opts.transport.close();
    },
  };
}
