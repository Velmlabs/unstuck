import fs from 'node:fs';
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import * as edge from '../src/edge';
import * as node from '../src/index';
import { InProcessUnstuck } from '../src/in-process';

describe('edge entry', () => {
  it('exports the same public names as the Node entry', () => {
    expect(Object.keys(edge).sort()).toEqual(Object.keys(node).sort());
    expect(edge.UnstuckConfigError).toBe(node.UnstuckConfigError);
    expect(edge.PageClosedError).toBe(node.PageClosedError);
  });

  // Checked by tsc (pnpm build type-checks test/): a Workers user and a Node user must see the same API.
  it('exports the same types as the Node entry (type-level parity)', () => {
    type Public<T> = { [K in keyof T]: T[K] }; // public members only (private ones differ by design)
    expectTypeOf<keyof typeof edge>().toEqualTypeOf<keyof typeof node>();
    expectTypeOf<ConstructorParameters<typeof edge.Unstuck>>().toEqualTypeOf<ConstructorParameters<typeof node.Unstuck>>();
    expectTypeOf<Public<edge.Unstuck>>().toEqualTypeOf<Public<node.Unstuck>>();
    expectTypeOf<edge.Unstuck['takeover']>().toEqualTypeOf<node.Unstuck['takeover']>();
    expectTypeOf<edge.Unstuck['close']>().toEqualTypeOf<node.Unstuck['close']>();
    expectTypeOf<edge.UnstuckOptions>().toEqualTypeOf<node.UnstuckOptions>();
    expectTypeOf<edge.TakeoverOptions>().toEqualTypeOf<node.TakeoverOptions>();
    expectTypeOf<edge.TakeoverLink>().toEqualTypeOf<node.TakeoverLink>();
    expectTypeOf<edge.TakeoverResult>().toEqualTypeOf<node.TakeoverResult>();
    expectTypeOf<edge.TakeoverStatus>().toEqualTypeOf<node.TakeoverStatus>();
    expectTypeOf<typeof edge.UnstuckConfigError>().toEqualTypeOf<typeof node.UnstuckConfigError>();
    expectTypeOf<typeof edge.UnstuckEngineError>().toEqualTypeOf<typeof node.UnstuckEngineError>();
    expectTypeOf<typeof edge.PageClosedError>().toEqualTypeOf<typeof node.PageClosedError>();
  });

  it('re-exports the same type-only names as the Node entry (the list the type-level test above covers)', () => {
    const typeNames = (file: string) =>
      [...fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').matchAll(/^export type \{([^}]+)\}/gm)]
        .flatMap((m) => m[1]!.split(',').map((n) => n.trim()))
        .sort();
    expect(typeNames('edge.ts')).toEqual(typeNames('index.ts'));
    expect(typeNames('edge.ts')).toEqual(['TakeoverLink', 'TakeoverOptions', 'TakeoverResult', 'TakeoverStatus', 'UnstuckOptions']);
  });

  it('validates options in the constructor', () => {
    expect(() => new edge.Unstuck({ apiKey: 'k', relay: 'wss://r.example' })).toThrow(edge.UnstuckConfigError);
  });

  it("refuses mode: 'binary': this entry has no engine binary", () => {
    expect(() => new edge.Unstuck({ mode: 'binary', apiKey: 'k' })).toThrow(edge.UnstuckConfigError);
    expect(() => new edge.Unstuck({ mode: 'binary' })).toThrow('binary mode needs Node.js: this runtime loaded the in-process entry, which has no engine binary');
    expect(() => new edge.Unstuck({ mode: 'in-process', apiKey: 'k' })).not.toThrow();
  });

  it('constructs with no options and delegates takeover and close to the in-process engine', async () => {
    const result = { status: 'resolved', sessionId: 's', url: 'u', durationS: 1 } as const;
    const takeover = vi.spyOn(InProcessUnstuck.prototype, 'takeover').mockResolvedValue(result);
    const close = vi.spyOn(InProcessUnstuck.prototype, 'close').mockResolvedValue();
    const u = new edge.Unstuck();
    const page = {};
    await expect(u.takeover(page, { reason: 'captcha' })).resolves.toBe(result);
    expect(takeover).toHaveBeenCalledWith(page, { reason: 'captcha' });
    await u.close();
    expect(close).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
