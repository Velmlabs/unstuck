// Entry for Workers and browsers (the workerd, worker and browser export conditions): everything runs in-process, so it
// never reaches Node built-ins or the engine binary. Deno and Bun load the Node entry and opt in with mode: 'in-process'.
// scripts/check-edge-graph.mjs proves that in CI.
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import { createMemorySessionStore, type SessionStore } from '@velmlabs/unstuck-core';
import { InProcessUnstuck } from './in-process';
import { createWrap } from './browser/wrap';
import type { WrapOptions, Wrapped } from './browser/options';
import { UnstuckConfigError } from './errors';
import { validateOptions, type TakeoverOptions, type UnstuckOptions } from './options';

export type { UnstuckOptions, TakeoverLink, TakeoverOptions } from './options';
export { UnstuckEngineError, UnstuckConfigError, UnstuckRescueError } from './errors';
export type { WrapOptions, PageGuard, RescueEvent, Wrapped } from './browser/options';
export type { SessionStore, SiteRecord } from '@velmlabs/unstuck-core';
export type { StoredCookie, SiteSession, HumanCheck, RescueStatus } from '@velmlabs/unstuck-protocol';
export { siteOf } from '@velmlabs/unstuck-core';
export { PageClosedError } from './attach';
export type { TakeoverResult, TakeoverStatus } from '@velmlabs/unstuck-protocol';

export class Unstuck {
  private readonly inner: InProcessUnstuck;
  /** Remembered sites live in memory here (no file system): one store per profile, for this client's lifetime. */
  private readonly stores = new Map<string, SessionStore>();
  private readonly wrapper = createWrap({
    takeover: (page, o) => this.takeover(page, o),
    store: (profile) => {
      let s = this.stores.get(profile);
      if (!s) this.stores.set(profile, (s = createMemorySessionStore()));
      return s;
    },
  });

  constructor(opts: UnstuckOptions = {}) {
    validateOptions(opts);
    if (opts.mode === 'binary') throw new UnstuckConfigError('binary mode needs Node.js: this runtime loaded the in-process entry, which has no engine binary');
    this.inner = new InProcessUnstuck(opts, {});
  }

  takeover(page: unknown, o: TakeoverOptions): Promise<TakeoverResult> {
    return this.inner.takeover(page, o);
  }

  /** Guards a Playwright page: a human check it lands on brings a person in (see the Node entry). */
  wrap<P extends object>(page: P, o?: WrapOptions): Wrapped<P> {
    return this.wrapper(page, o);
  }

  /** Cancels running takeovers (`engine_closed`) and resolves once they have ended; safe to call from inside onLink. */
  close(): Promise<void> {
    return this.inner.close();
  }
}
