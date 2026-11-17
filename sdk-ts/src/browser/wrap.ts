// unstuck.wrap(page): the page's own methods, guarded. Shared by the Node and edge entries, so no Node built-ins here.
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import { createGuard, type Guard, type RenderCheck, type SessionStore } from '@velmlabs/unstuck-core';
import { attachPage } from '../attach';
import { toCdpClient } from '../cdp-adapter';
import { UnstuckRescueError } from '../errors';
import type { TakeoverOptions } from '../options';
import { guardFactory, guardLocator, guardMethod, type GuardedRun, type HookKind } from './hooks';
import type { PageGuard, RescueEvent, WrapOptions, Wrapped } from './options';
import { isPlaywrightPage, PLAYWRIGHT_HOOKS, playwrightBrowserKey, playwrightNewPage } from './playwright';

/** How one automation library's pages are recognised and hooked. */
export interface PageAdapter {
  is(page: unknown): boolean;
  hooks: {
    page: Readonly<Record<string, HookKind>>;
    locatorFactories: readonly string[];
    locatorChain: readonly string[];
    locatorActions: readonly string[];
  };
  browserKey(page: unknown): object;
  newPage(page: unknown): Promise<unknown>;
}

const ADAPTERS: PageAdapter[] = [{ is: isPlaywrightPage, hooks: PLAYWRIGHT_HOOKS, browserKey: playwrightBrowserKey, newPage: playwrightNewPage }];

export const UNSUPPORTED_PAGE = 'Unsupported page object: pass a Playwright or Puppeteer Page';

export function adapterFor(page: unknown): PageAdapter {
  const a = ADAPTERS.find((x) => x.is(page));
  if (!a) throw new TypeError(UNSUPPORTED_PAGE);
  return a;
}

export interface WrapDeps {
  takeover(page: unknown, o: TakeoverOptions): Promise<TakeoverResult>;
  store(profile: string): SessionStore;
  renderCheck?(page: unknown): RenderCheck | undefined;
}

const WRAPPED = new WeakSet<object>();

export function createWrap(deps: WrapDeps): <P extends object>(page: P, o?: WrapOptions) => Wrapped<P> {
  return <P extends object>(page: P, o: WrapOptions = {}): Wrapped<P> => {
    if (WRAPPED.has(page)) return page as Wrapped<P>;
    const adapter = adapterFor(page);
    const profile = o.profile ?? 'default';
    const store = o.store ?? deps.store(profile);
    let guard: Promise<Guard> | null = null;
    let current: Guard | null = null;
    const takeoverOptions = (reason: string): TakeoverOptions => ({
      reason,
      ...(o.timeoutS !== undefined ? { timeoutS: o.timeoutS } : {}),
      ...(o.allowedSites !== undefined ? { allowedSites: o.allowedSites } : {}),
      ...(o.alerts !== undefined ? { alerts: o.alerts } : {}),
      ...(o.requireCode !== undefined ? { requireCode: o.requireCode } : {}),
    });
    // Attached on first use: wrapping costs nothing until the agent drives the page.
    const ensure = (): Promise<Guard> => {
      guard ??= (async () => {
        const cdp = toCdpClient(await attachPage(page));
        const renderCheck = deps.renderCheck?.(page);
        const g = await createGuard({
          cdp,
          store,
          takeover: ({ reason }) => deps.takeover(page, takeoverOptions(reason)),
          profile,
          ...(o.rescue ? { rescue: o.rescue } : {}),
          ...(o.remember !== undefined ? { remember: o.remember } : {}),
          ...(o.maxRescuesPerHour !== undefined ? { maxRescuesPerHour: o.maxRescuesPerHour } : {}),
          ...(o.allowedSites ? { allowedSites: o.allowedSites } : {}),
          ...(o.onRescue ? { onRescue: o.onRescue } : {}),
          ...(renderCheck ? { canRenderCaptcha: renderCheck } : {}),
        });
        current = g;
        return g;
      })();
      guard.catch(() => (guard = null)); // a page that couldn't attach is tried again on the next call
      return guard;
    };
    const settle = (e: RescueEvent | null) => {
      if (e && e.status !== 'resolved' && o.onRescueFail !== 'return') throw new UnstuckRescueError(e);
    };

    const run: GuardedRun = async (call, c) => {
      const g = await ensure();
      settle(await g.before(c.url !== undefined ? { url: c.url } : {}));
      const out = await call();
      settle(await g.after(c.navigates ? (c.requestedUrl !== undefined ? { requestedUrl: c.requestedUrl } : {}) : { mayNavigate: c.mayNavigate ?? false }));
      return out;
    };

    const { hooks } = adapter;
    for (const [name, kind] of Object.entries(hooks.page)) guardMethod(page, name, kind, run);
    for (const name of hooks.locatorFactories) guardFactory(page, name, (l) => guardLocator(l, run, hooks.locatorActions, hooks.locatorChain));

    const unstuck: PageGuard = {
      get lastRescue() {
        return current?.lastRescue ?? null;
      },
      check: async () => (await ensure()).check(),
      askHuman: async (reason) => (await ensure()).askHuman(reason),
      getSession: async (domain) => (await ensure()).getSession(domain),
      rememberSite: async (domain) => (await ensure()).rememberSite(domain),
      forgetSite: async (domain) => (await ensure()).forgetSite(domain),
      forgetAll: async () => (await ensure()).forgetAll(),
    };
    Object.defineProperty(page, 'unstuck', { value: unstuck, configurable: true, enumerable: false });
    WRAPPED.add(page);
    return page as Wrapped<P>;
  };
}
