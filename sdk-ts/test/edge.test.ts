import { describe, it, expect, vi } from 'vitest';
import * as edge from '../src/edge';
import * as node from '../src/index';
import { InProcessUnstuck } from '../src/in-process';

describe('edge entry', () => {
  it('exports the same public names as the Node entry', () => {
    expect(Object.keys(edge).sort()).toEqual(Object.keys(node).sort());
    expect(edge.UnstuckConfigError).toBe(node.UnstuckConfigError);
    expect(edge.PageClosedError).toBe(node.PageClosedError);
  });

  it('validates options in the constructor', () => {
    expect(() => new edge.Unstuck({ apiKey: 'k', relay: 'wss://r.example' })).toThrow(edge.UnstuckConfigError);
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
