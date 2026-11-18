// The guard over RPC: SDKs without their own detection (Python, and TS through the engine) open a core Guard on a page
// they tunnel to the engine, and the engine runs its takeovers.
import {
  Methods,
  type GuardAfterParams,
  type GuardAskParams,
  type GuardBeforeParams,
  type GuardOpenParams,
  type GuardRescueParams,
  type GuardSiteParams,
  type PageCreateResult,
  type PaintCheckParams,
  type PaintCheckResult,
  type RpcPeer,
  type TakeoverParams,
} from '@velmlabs/unstuck-protocol';
import {
  createFileSessionStore,
  createGuard,
  hostnames,
  onceRenderCheck,
  profileFile,
  type CloudAlerter,
  type Engine,
  type Guard,
  type LinkHandler,
  type PopupSource,
  type RenderCheck,
  type StoreFs,
} from '@velmlabs/unstuck-core';
import { createTunneledCdp } from './tunnel';
import { probeCaptchaPaint } from './browser/paint-check';
import { unstuckHome } from './browser/node-store-fs';

/** The engine has a Cloud alerter only with UNSTUCK_API_KEY and no relay of its own (flags or UNSTUCK_RELAY_URL). */
export const REQUIRED_WITHOUT_CLOUD =
  "alerts: 'required' needs Unstuck Cloud (apiKey or UNSTUCK_API_KEY): the local viewer server and self-hosted relays send no phone alerts";

export interface GuardHostDeps {
  peer: RpcPeer;
  engine: Engine;
  env: Record<string, string | undefined>;
  storeFs: StoreFs;
  alerter?: CloudAlerter;
  agentName?: string;
  popupsFor(pageId: string): PopupSource;
  linkFor(pageId: string, site: string | undefined, alerts: TakeoverParams['alerts']): LinkHandler;
}

const fail = (code: string, message: string) => Object.assign(new Error(message), { code });

export function registerGuardMethods(d: GuardHostDeps): { closeAll(): Promise<void> } {
  const { peer } = d;
  const guards = new Map<string, Guard>();
  const renderChecks = new Map<string, RenderCheck>();
  let nextId = 1;

  // One probe per browser: a new tab in it shows the paint probe, then closes.
  const renderCheckFor = (pageId: string, browserKey: string): RenderCheck => {
    let check = renderChecks.get(browserKey);
    if (!check) {
      check = onceRenderCheck(() =>
        probeCaptchaPaint(async (url) => {
          const tab = (await peer.request<PageCreateResult>(Methods.pageCreate, { pageId })).pageId;
          const cdp = createTunneledCdp(peer, tab);
          const close = async () => void (await peer.request(Methods.pageClose, { pageId: tab }));
          try {
            await cdp.send('Page.navigate', { url });
          } catch (e) {
            await close().catch(() => {});
            throw e;
          }
          return { cdp, close };
        }),
      );
      renderChecks.set(browserKey, check);
    }
    return check;
  };

  const guardOf = (guardId: string): Guard => {
    const g = guards.get(guardId);
    if (!g) throw fail('unknown_guard', `no open guard ${guardId}`);
    return g;
  };

  peer.handle(Methods.guardOpen, async (raw) => {
    const p = raw as GuardOpenParams;
    if (p.alerts === 'required' && !d.alerter) throw fail('config_error', REQUIRED_WITHOUT_CLOUD);
    let file: string;
    try {
      file = profileFile(unstuckHome(d.env), p.profile ?? 'default');
    } catch (e) {
      throw fail('config_error', (e as Error).message);
    }
    const guardId = `g${nextId++}`;
    const cdp = createTunneledCdp(peer, p.pageId);
    const note = (active: boolean) => peer.notify(Methods.guardRescue, { guardId, pageId: p.pageId, active } satisfies GuardRescueParams);
    const guard = await createGuard({
      cdp,
      store: createFileSessionStore(d.storeFs, file),
      profile: p.profile,
      rescue: p.rescue,
      remember: p.remember,
      maxRescuesPerHour: p.maxRescuesPerHour,
      approvalTimeoutS: p.approvalTimeoutS,
      allowedSites: p.allowedSites,
      canRenderCaptcha: renderCheckFor(p.pageId, p.browserKey),
      takeover: async ({ reason, site, kind, mode, timeoutS }) => {
        note(true);
        try {
          return await d.engine.takeover(cdp, {
            reason,
            site,
            // An approval waits as long as the guard's approval timeout; a control takeover as long as `timeoutS`.
            timeoutS: mode === 'approval' ? (timeoutS ?? p.timeoutS) : p.timeoutS,
            kind,
            mode,
            agentName: d.agentName,
            requireCode: p.requireCode,
            allowedSites: hostnames(p.allowedSites),
            onLink: d.linkFor(p.pageId, site, p.alerts),
            popups: d.popupsFor(p.pageId),
          });
        } finally {
          note(false);
        }
      },
    });
    guards.set(guardId, guard);
    return { guardId };
  });

  peer.handle(Methods.guardBefore, (raw) => {
    const p = raw as GuardBeforeParams;
    return guardOf(p.guardId).before({ url: p.url });
  });
  peer.handle(Methods.guardAfter, (raw) => {
    const p = raw as GuardAfterParams;
    return guardOf(p.guardId).after({ requestedUrl: p.requestedUrl, mayNavigate: p.mayNavigate });
  });
  peer.handle(Methods.guardCheck, (raw) => guardOf((raw as GuardSiteParams).guardId).check());
  peer.handle(Methods.guardAskHuman, (raw) => {
    const p = raw as GuardAskParams;
    return guardOf(p.guardId).askHuman(p.reason);
  });
  peer.handle(Methods.guardSession, (raw) => {
    const p = raw as GuardSiteParams;
    return guardOf(p.guardId).getSession(p.domain);
  });
  const domainOf = (p: GuardSiteParams) => {
    if (!p.domain) throw fail('bad_params', 'domain is required, e.g. "shop.example"');
    return p.domain;
  };
  const done = async (work: Promise<void>) => (await work, {});
  peer.handle(Methods.guardRemember, (raw) => {
    const p = raw as GuardSiteParams;
    return done(guardOf(p.guardId).rememberSite(domainOf(p)));
  });
  peer.handle(Methods.guardForget, (raw) => {
    const p = raw as GuardSiteParams;
    return done(guardOf(p.guardId).forgetSite(domainOf(p)));
  });
  peer.handle(Methods.guardForgetAll, (raw) => done(guardOf((raw as GuardSiteParams).guardId).forgetAll()));
  peer.handle(Methods.guardClose, async (raw) => {
    const { guardId } = raw as GuardSiteParams;
    const g = guardOf(guardId);
    guards.delete(guardId);
    await g.close();
    return {};
  });
  peer.handle(Methods.paintCheck, async (raw): Promise<PaintCheckResult> => {
    const p = raw as PaintCheckParams;
    return { paint: await renderCheckFor(p.pageId, p.browserKey)() };
  });

  return {
    async closeAll() {
      const open = [...guards.values()];
      guards.clear();
      await Promise.all(open.map((g) => g.close()));
    },
  };
}
