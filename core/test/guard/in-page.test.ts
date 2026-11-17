import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { inPageSource } from '../../src/guard/in-page';

describe('inPageSource', () => {
  it("runs a function whose source carries esbuild's __name calls (tsx, keepNames) where __name is not defined", () => {
    // What tsx makes of `const f = (x) => x * 2` inside a function: the helper call stays in the serialized source.
    const fn = { toString: () => 'function (n) { const double = __name((x) => x * 2, "double"); return double(n); }' } as unknown as (n: number) => number;
    expect(() => vm.runInNewContext(`(${fn.toString()})(21)`)).toThrow(/__name is not defined/);
    expect(vm.runInNewContext(`(${inPageSource(fn)})(21)`)).toBe(42);
  });

  it('a plain function is unchanged in behaviour', () => {
    expect(vm.runInNewContext(`(${inPageSource((a: number, b: number) => a + b)})(2, 3)`)).toBe(5);
  });
});
