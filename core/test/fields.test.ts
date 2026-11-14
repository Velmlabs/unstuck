import { describe, it, expect } from 'vitest';
import { FakeCdp } from '../src/testing';
import { scanFields, focusedKind } from '../src/stream/fields';

describe('scanFields / focusedKind (CDP edge cases)', () => {
  it('asks for a by-value result', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => ({ result: { value: [{ x: 1, y: 2, w: 3, h: 4, kind: 'otp' }] } }));
    expect(await scanFields(cdp)).toEqual([{ x: 1, y: 2, w: 3, h: 4, kind: 'otp' }]);
    expect(cdp.calls.find((c) => c.method === 'Runtime.evaluate')!.params).toMatchObject({ returnByValue: true });
  });

  it('returns no fields when evaluation throws or reports an exception', async () => {
    const throws = new FakeCdp();
    throws.respond('Runtime.evaluate', () => {
      throw new Error('Execution context was destroyed');
    });
    expect(await scanFields(throws)).toEqual([]);
    expect(await focusedKind(throws)).toBe(null);
    const exception = new FakeCdp();
    exception.respond('Runtime.evaluate', () => ({ result: {}, exceptionDetails: { text: 'CSP' } }));
    expect(await scanFields(exception)).toEqual([]);
    expect(await focusedKind(exception)).toBe(null);
  });

  it('drops anything that is not a well-formed field', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => ({ result: { value: [{ x: 1, y: 2, w: 3, h: 4, kind: 'date' }, 'x', null] } }));
    expect(await scanFields(cdp)).toEqual([]);
    const odd = new FakeCdp();
    odd.respond('Runtime.evaluate', () => ({ result: { value: 'weird' } }));
    expect(await focusedKind(odd)).toBe(null);
    expect(await scanFields(odd)).toEqual([]);
  });
});
