/** How long a screenshot (and the layout metrics read with it) may take before the caller gives up on it. */
export const CAPTURE_TIMEOUT_MS = 5_000;

/**
 * `p`, or a rejection once `ms` have passed: Chrome can leave a CDP call unanswered (Page.captureScreenshot on a hidden
 * or background tab), and the caller must not wait on it forever. `p` itself is left to settle on its own.
 */
export function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
