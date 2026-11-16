// Entry for Workers and browsers (the workerd, worker and browser export conditions): everything runs in-process, so it
// never reaches Node built-ins or the engine binary. Deno and Bun load the Node entry and opt in with mode: 'in-process'.
// scripts/check-edge-graph.mjs proves that in CI.
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import { InProcessUnstuck } from './in-process';
import { UnstuckConfigError } from './errors';
import { validateOptions, type TakeoverOptions, type UnstuckOptions } from './options';

export type { UnstuckOptions, TakeoverLink, TakeoverOptions } from './options';
export { UnstuckEngineError, UnstuckConfigError } from './errors';
export { PageClosedError } from './attach';
export type { TakeoverResult, TakeoverStatus } from '@velmlabs/unstuck-protocol';

export class Unstuck {
  private readonly inner: InProcessUnstuck;

  constructor(opts: UnstuckOptions = {}) {
    validateOptions(opts);
    if (opts.mode === 'binary') throw new UnstuckConfigError('binary mode needs Node.js: this runtime loaded the in-process entry, which has no engine binary');
    this.inner = new InProcessUnstuck(opts, {});
  }

  takeover(page: unknown, o: TakeoverOptions): Promise<TakeoverResult> {
    return this.inner.takeover(page, o);
  }

  /** Cancels running takeovers (`engine_closed`) and resolves once they have ended; safe to call from inside onLink. */
  close(): Promise<void> {
    return this.inner.close();
  }
}
