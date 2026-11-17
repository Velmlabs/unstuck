// The browser `--mcp --browser` (or `--tools browser`) drives: started on first use, one tab of our own, one guard on it.
import os from 'node:os';
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import {
  createFileSessionStore,
  createGuard,
  onceRenderCheck,
  profileFile,
  type Engine,
  type Guard,
  type LinkInfo,
  type SessionStore,
  type StoreFs,
  type TakeoverControl,
} from '@velmlabs/unstuck-core';
import { connectCdp, type DirectCdp } from '../direct-cdp';
import { findChrome, launchChrome, launchObscura, type LaunchedBrowser } from './launcher';
import { probeCaptchaPaint } from './paint-check';
import type { Snapshot } from './snapshot';

export interface BrowseConfig {
  source: { kind: 'chrome' } | { kind: 'obscura'; path: string } | { kind: 'cdp'; url: string };
  profile: string;
  remember: boolean;
  maxRescuesPerHour: number;
  /** Where profiles live (UNSTUCK_HOME, else ~/.unstuck). */
  home: string;
  /** How long a browsing tool waits for a person before it returns human_needed (default 40 s). */
  inToolWaitMs?: number;
}

export const IN_TOOL_WAIT_MS = 40_000;

type ReadyHandler = (info: LinkInfo, control: TakeoverControl) => void;

export interface BrowserSessionDeps {
  engine: Engine;
  storeFs: StoreFs;
  runTakeover: (cdp: DirectCdp, reason: string, onReady: ReadyHandler) => Promise<TakeoverResult>;
  launch?: { chrome?: typeof launchChrome; obscura?: typeof launchObscura; findChrome?: typeof findChrome };
  connect?: typeof connectCdp;
}

interface Live {
  url: string;
  cdp: DirectCdp;
  guard: Guard;
  launched: LaunchedBrowser | null;
  /** What tab() hands out: the same object every time. */
  pair: { cdp: DirectCdp; guard: Guard };
}

export class BrowserSession {
  /** The sessionId of the rescue a person is working on, if any. */
  holder: string | null = null;
  /** The last snapshot the agent got; its refs are what click/type/select act on. A main-frame navigation clears it. */
  snapshot: Snapshot | null = null;
  readonly store: SessionStore;
  private starting: Promise<Live> | null = null;
  private live: Live | null = null;
  private readonly listeners = new Set<ReadyHandler>();

  constructor(
    private readonly c: BrowseConfig,
    private readonly d: BrowserSessionDeps,
  ) {
    this.store = createFileSessionStore(d.storeFs, profileFile(c.home, c.profile));
  }

  /** True when this session started the browser (so it may change the browser's own cookies). */
  get launched(): boolean {
    return !!this.live?.launched;
  }

  /** Our tab and its guard; starts the browser on the first call (concurrent callers share one start). */
  async tab(): Promise<{ cdp: DirectCdp; guard: Guard }> {
    this.starting ??= this.start();
    const p = this.starting;
    p.catch(() => {
      if (this.starting === p) this.starting = null; // a failed start is tried again on the next call
    });
    return (await p).pair;
  }

  /** The browser's DevTools URL and our tab's target id (the takeover tools connect to it separately). */
  async endpoint(): Promise<{ url: string; targetId: string }> {
    await this.tab();
    return { url: this.live!.url, targetId: this.live!.cdp.targetId };
  }

  onTakeoverStart(cb: ReadyHandler): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  private async start(): Promise<Live> {
    const connect = this.d.connect ?? connectCdp;
    const src = this.c.source;
    let launched: LaunchedBrowser | null = null;
    let url: string;
    if (src.kind === 'cdp') url = src.url;
    else if (src.kind === 'obscura') {
      launched = await (this.d.launch?.obscura ?? launchObscura)({ path: src.path });
      url = launched.cdpUrl;
    } else {
      const path = (this.d.launch?.findChrome ?? findChrome)({ platform: process.platform, env: process.env, home: os.homedir() });
      launched = await (this.d.launch?.chrome ?? launchChrome)({ path });
      url = launched.cdpUrl;
    }
    try {
      const cdp = await connect(url, { createUrl: 'about:blank' });
      cdp.on('Page.frameNavigated', (p: { frame?: { parentId?: string } }) => {
        if (!p.frame?.parentId) this.snapshot = null;
      });
      const canRenderCaptcha = onceRenderCheck(() =>
        probeCaptchaPaint(async (probeUrl) => {
          const tab = await connect(url, { createUrl: probeUrl });
          return { cdp: tab, close: () => closeTab(tab) };
        }),
      );
      const guard = await createGuard({
        cdp,
        store: this.store,
        profile: this.c.profile,
        remember: this.c.remember,
        maxRescuesPerHour: this.c.maxRescuesPerHour,
        canRenderCaptcha,
        takeover: ({ reason }) =>
          this.d
            .runTakeover(cdp, reason, (info, control) => {
              this.holder = info.sessionId;
              for (const cb of [...this.listeners]) cb(info, control);
            })
            .finally(() => {
              this.holder = null;
            }),
      });
      this.live = { url, cdp, guard, launched, pair: { cdp, guard } };
      return this.live;
    } catch (e) {
      await launched?.stop();
      throw e;
    }
  }

  /** Closes the guard and our tab, then stops a browser we launched (a cdp browser keeps running). */
  async close(): Promise<void> {
    const starting = this.starting;
    this.starting = null;
    const live = await starting?.catch(() => null);
    this.live = null;
    if (!live) return;
    await live.guard.close();
    await closeTab(live.cdp);
    await live.launched?.stop();
  }
}

async function closeTab(tab: DirectCdp): Promise<void> {
  await tab.send('Page.close').catch(() => {});
  await tab.close().catch(() => {});
}
