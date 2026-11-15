import readline from 'node:readline';
import {
  createRpcPeer,
  Methods,
  PROTOCOL_VERSION,
  type HelloParams,
  type PagePopupParams,
  type HelloResult,
  type TakeoverParams,
} from '@velmlabs/unstuck-protocol';
import { createEngine, isPublicSuffix, type CdpClient, type EventLog, type LinkInfo, type Transport } from '@velmlabs/unstuck-core';
import { createTunneledCdp } from './tunnel';

export interface StdioHostOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  transport: Transport;
  log?: EventLog;
  version: string;
  /** Default for takeovers that don't say (UNSTUCK_REQUIRE_CODE=1). */
  requireCode?: boolean;
  /** Sends the link to the user's paired phones (Cloud only); skipped per takeover by `alerts: false`. */
  alerter?: (info: LinkInfo, site: string | undefined) => Promise<void>;
}

/**
 * Serves one SDK over JSON lines. stdout carries only protocol lines.
 * Resolves after `shutdown` or when the SDK closes stdin.
 */
export function runStdioHost(opts: StdioHostOptions): Promise<void> {
  const peer = createRpcPeer((line) => opts.output.write(line + '\n'));
  const engine = createEngine({ transport: opts.transport, log: opts.log, requireCode: opts.requireCode });
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

  // Popups the SDK attached, routed to the takeover running on their opener page.
  const popupListeners = new Map<string, Set<(popup: CdpClient) => void>>();
  peer.onNotification(Methods.pagePopup, (raw) => {
    const p = raw as PagePopupParams;
    for (const cb of [...(popupListeners.get(p.pageId) ?? [])]) cb(createTunneledCdp(peer, p.popupPageId));
  });

  peer.handle(Methods.takeover, (raw) => {
    const p = raw as TakeoverParams;
    const listeners = new Set<(popup: CdpClient) => void>();
    popupListeners.set(p.pageId, listeners);
    return engine
      .takeover(createTunneledCdp(peer, p.pageId), {
        reason: p.reason,
        timeoutS: p.timeoutS,
        site: p.site,
        requireCode: p.requireCode,
        allowedSites: hostnames(p.allowedSites),
        onLink: (info) => {
          peer.notify(Methods.takeoverLink, { ...info, pageId: p.pageId });
          if (p.alerts !== false) void opts.alerter?.(info, p.site);
        },
        popups: {
          onPopup(cb) {
            listeners.add(cb);
            return () => void listeners.delete(cb);
          },
        },
      })
      .finally(() => {
        if (popupListeners.get(p.pageId) === listeners) popupListeners.delete(p.pageId);
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

/** Keeps only plausible hostnames that aren't bare public suffixes (a leading "*." is accepted), at most 20. */
export function hostnames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h): h is string => typeof h === 'string' && /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.?$/i.test(h) && h.length <= 253)
    // Never a bare public suffix ("com", "co.uk", "github.io"): that would open a whole TLD or platform.
    .filter((h) => h.toLowerCase() === 'localhost' || !isPublicSuffix(h))
    .slice(0, 20);
}
