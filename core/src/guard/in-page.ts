/**
 * A function's source, ready to run inside a page (`(${inPageSource(fn)})(args)`). Compilers that keep function names
 * (esbuild's keepNames, which tsx turns on) wrap inner functions in `__name(...)` calls; the page has no `__name`, so
 * the source would throw there. A local no-op stands in for it.
 */
export function inPageSource(fn: (...args: never[]) => unknown): string {
  return `(function () { var __name = function (f) { return f; }; return (${fn.toString()}); })()`;
}
