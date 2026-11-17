/** Runs one page call between the guard's before and after checks, and applies the rescue-failure policy. */
export type GuardedRun = <T>(call: () => Promise<T>, o: { url?: string; requestedUrl?: string; navigates: boolean; mayNavigate?: boolean }) => Promise<T>;

export interface HookKind {
  navigates: boolean;
  mayNavigate?: boolean;
  requestedUrl?: (args: unknown[]) => string | undefined;
}

/** Replaces `target[name]` (own property, so the prototype stays untouched) with its guarded version. */
export function guardMethod(target: object, name: string, kind: HookKind, run: GuardedRun): void {
  const t = target as Record<string, unknown>;
  const original = t[name];
  if (typeof original !== 'function') return;
  t[name] = function (this: unknown, ...args: unknown[]) {
    const url = kind.requestedUrl?.(args);
    return run(() => (original as (...a: unknown[]) => Promise<unknown>).apply(this, args), {
      ...(url !== undefined ? { url, requestedUrl: url } : {}),
      navigates: kind.navigates,
      ...(kind.mayNavigate !== undefined ? { mayNavigate: kind.mayNavigate } : {}),
    });
  };
}

/** Replaces a locator factory on `target` so every locator it returns is guarded. */
export function guardFactory(target: object, name: string, wrapResult: (l: object) => object): void {
  const t = target as Record<string, unknown>;
  const original = t[name];
  if (typeof original !== 'function') return;
  t[name] = function (this: unknown, ...args: unknown[]) {
    const out = (original as (...a: unknown[]) => unknown).apply(this, args);
    return out && typeof out === 'object' ? wrapResult(out) : out;
  };
}

const RAW = Symbol('unstuck.rawLocator');

/** The real locator behind a guarded one (the library's own methods want theirs, e.g. `a.or(b)`). */
export const rawLocator = (l: unknown): unknown => (l && typeof l === 'object' && (l as Record<symbol, unknown>)[RAW]) || l;

/**
 * A Proxy over a locator: methods in `chain` return guarded locators, methods in `actions` run guarded (they may
 * navigate, e.g. a link click), and everything else is the locator's own.
 */
export function guardLocator<L extends object>(locator: L, run: GuardedRun, actions: readonly string[], chain: readonly string[]): L {
  return new Proxy(locator, {
    get(target, prop, receiver) {
      if (prop === RAW) return target;
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (chain.includes(prop)) {
        return (...args: unknown[]) => {
          const out = fn.apply(target, args.map(rawLocator));
          return out && typeof out === 'object' ? guardLocator(out as object, run, actions, chain) : out;
        };
      }
      if (actions.includes(prop)) return (...args: unknown[]) => run(() => fn.apply(target, args) as Promise<unknown>, { navigates: false, mayNavigate: true });
      return (...args: unknown[]) => fn.apply(target, args.map(rawLocator));
    },
  });
}
