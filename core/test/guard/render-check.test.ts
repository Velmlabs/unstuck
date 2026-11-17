import { describe, it, expect, vi } from 'vitest';
import { onceRenderCheck, BROWSER_CANNOT_RENDER_HINT } from '../../src/guard/render-check';

describe('onceRenderCheck', () => {
  it('probes once per connection: a true or false answer is cached', async () => {
    const fn = vi.fn(async () => false as const);
    const check = onceRenderCheck(fn);
    expect(await check()).toBe(false);
    expect(await check()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries after 'unknown' or a failed probe", async () => {
    const answers: (boolean | 'unknown' | Error)[] = ['unknown', new Error('tab closed'), true];
    const fn = vi.fn(async () => {
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return a;
    });
    const check = onceRenderCheck(fn);
    expect(await check()).toBe('unknown');
    expect(await check()).toBe('unknown');
    expect(await check()).toBe(true);
    expect(await check()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('has the exact hint', () => expect(BROWSER_CANNOT_RENDER_HINT).toBe("this browser can't show CAPTCHAs; use Chrome for this site"));
});
