// Entry for Workers, Deno, Bun and browsers: everything runs in-process, so it never reaches Node built-ins or the engine binary.
// scripts/check-edge-graph.mjs proves that in CI.
import type { TakeoverResult } from '@velmlabs/unstuck-protocol';
import { InProcessUnstuck } from './in-process';
import { validateOptions, type TakeoverOptions, type UnstuckOptions } from './options';

export type { UnstuckOptions, TakeoverLink, TakeoverOptions } from './options';
export { UnstuckEngineError, UnstuckConfigError } from './errors';
export { PageClosedError } from './attach';
export type { TakeoverResult, TakeoverStatus } from '@velmlabs/unstuck-protocol';

export class Unstuck {
  private readonly inner: InProcessUnstuck;

  constructor(opts: UnstuckOptions = {}) {
    validateOptions(opts);
    this.inner = new InProcessUnstuck(opts, {});
  }

  takeover(page: unknown, o: TakeoverOptions): Promise<TakeoverResult> {
    return this.inner.takeover(page, o);
  }

  /** Waits for in-flight takeovers: do not await it from inside onLink. */
  close(): Promise<void> {
    return this.inner.close();
  }
}
