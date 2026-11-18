import readline from 'node:readline';
import {
  createRpcPeer,
  Methods,
  PROTOCOL_MINOR,
  PROTOCOL_VERSION,
  type HelloParams,
  type PagePopupParams,
  type HelloResult,
  type AskParams,
  type AskLinkParams,
  type TakeoverParams,
} from '@velmlabs/unstuck-protocol';
import {
  checkAsk,
  createEngine,
  hostnames,
  sendTakeoverAlert,
  type CdpClient,
  type CloudAlerter,
  type EventLog,
  type LinkHandler,
  type PopupSource,
  type StoreFs,
  type Transport,
} from '@velmlabs/unstuck-core';
import { createTunneledCdp } from './tunnel';
import { registerGuardMethods, REQUIRED_WITHOUT_CLOUD } from './guard-host';
import { nodeStoreFs } from './browser/node-store-fs';

export { REQUIRED_WITHOUT_CLOUD };

const MODES: readonly unknown[] = ['control', 'approval'];
const KINDS: readonly unknown[] = ['challenge', 'approval', 'login', 'question', 'other'];

/** What checkAsk leaves open: the flags' types (an RPC peer may send anything). */
function askTypeProblem(p: AskParams): string | null {
  const { allowText, private: priv, alerts } = p as { [k in keyof AskParams]?: unknown };
  if (allowText !== undefined && typeof allowText !== 'boolean') return 'allowText must be true or false';
  if (priv !== undefined && typeof priv !== 'boolean') return 'private must be true or false';
  if (alerts !== undefined && typeof alerts !== 'boolean' && alerts !== 'required') return "alerts must be true, false or 'required'";
  return null;
}

export interface StdioHostOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  transport: Transport;
  log?: EventLog;
  version: string;
  /** Default for takeovers that don't say (UNSTUCK_REQUIRE_CODE=1). */
  requireCode?: boolean;
  /** Sends the link to the user's paired phones (Cloud only); skipped per takeover by `alerts: false`. */
  alerter?: CloudAlerter;
  /** Where remembered sites live (UNSTUCK_HOME); defaults to process.env. */
  env?: Record<string, string | undefined>;
  storeFs?: StoreFs;
  /** Who is asking (UNSTUCK_AGENT_NAME / --agent-name, cleaned): shown on the viewer's card as well as the alert. */
  agentName?: string;
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
      await guards.closeAll();
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
    // Any minor of major 1 is served: an SDK only uses what `capabilities` lists.
    return { engineVersion: opts.version, protocolVersion: PROTOCOL_VERSION, protocolMinor: PROTOCOL_MINOR, capabilities: ['guard', 'paintCheck', 'ask'] };
  });

  // Popups the SDK attached, routed to the takeover running on their opener page.
  const popupListeners = new Map<string, Set<(popup: CdpClient) => void>>();
  peer.onNotification(Methods.pagePopup, (raw) => {
    const p = raw as PagePopupParams;
    for (const cb of [...(popupListeners.get(p.pageId) ?? [])]) cb(createTunneledCdp(peer, p.popupPageId));
  });
  const popupsFor = (pageId: string): PopupSource => ({
    onPopup(cb) {
      const set = popupListeners.get(pageId) ?? new Set();
      popupListeners.set(pageId, set);
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0 && popupListeners.get(pageId) === set) popupListeners.delete(pageId);
      };
    },
  });
  const linkFor =
    (pageId: string, site: string | undefined, alerts: TakeoverParams['alerts']): LinkHandler =>
    (info, takeover) => {
      // The alert starts first: if passing the link on to the SDK throws, the paired phones still get it.
      sendTakeoverAlert(opts.alerter, alerts, info, site, takeover);
      peer.notify(Methods.takeoverLink, { ...info, pageId });
    };
  const guards = registerGuardMethods({ peer, engine, env: opts.env ?? process.env, storeFs: opts.storeFs ?? nodeStoreFs(), alerter: opts.alerter, agentName: opts.agentName, popupsFor, linkFor });

  peer.handle(Methods.takeover, (raw) => {
    const p = raw as TakeoverParams;
    // `kind` is readable by Cloud, so only the known words get through (never free text).
    if (p.mode !== undefined && !MODES.includes(p.mode)) throw Object.assign(new Error('mode must be control or approval'), { code: 'bad_params' });
    if (p.kind !== undefined && !KINDS.includes(p.kind)) throw Object.assign(new Error(`kind must be one of ${KINDS.join(', ')}`), { code: 'bad_params' });
    if (p.alerts === 'required' && !opts.alerter) throw Object.assign(new Error(REQUIRED_WITHOUT_CLOUD), { code: 'config_error' });
    return engine.takeover(createTunneledCdp(peer, p.pageId), {
      reason: p.reason,
      timeoutS: p.timeoutS,
      site: p.site,
      requireCode: p.requireCode,
      allowedSites: hostnames(p.allowedSites),
      onLink: linkFor(p.pageId, p.site, p.alerts),
      popups: popupsFor(p.pageId),
      mode: p.mode,
      kind: p.kind ?? 'other',
      agentName: opts.agentName,
    });
  });

  peer.handle(Methods.ask, (raw) => {
    const p = (raw ?? {}) as AskParams;
    const problem = checkAsk(p) ?? askTypeProblem(p);
    if (problem) throw Object.assign(new Error(problem), { code: 'bad_params' });
    if (p.alerts === 'required' && !opts.alerter) throw Object.assign(new Error(REQUIRED_WITHOUT_CLOUD), { code: 'config_error' });
    // Quick answers are choice buttons only (Cloud rejects a readable question without choices).
    const quick = p.private === false && p.choices ? { question: p.question, choices: p.choices } : undefined;
    return engine.ask({
      question: p.question,
      choices: p.choices,
      allowText: p.allowText,
      private: p.private,
      details: p.details,
      timeoutS: p.timeoutS,
      agentName: opts.agentName,
      onLink: (info, takeover) => {
        // Like linkFor: the alert starts first. A question has no page, so no site.
        sendTakeoverAlert(opts.alerter, p.alerts, { ...info, kind: 'question' }, undefined, takeover, quick);
        const { sessionId, url, reason, expiresAt, code } = info;
        peer.notify(Methods.askLink, { sessionId, url, reason, expiresAt, ...(code ? { code } : {}) } satisfies AskLinkParams);
      },
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
