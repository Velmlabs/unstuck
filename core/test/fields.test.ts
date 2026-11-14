import { describe, it, expect } from 'vitest';
import { FakeCdp } from '../src/testing';
import { scanFields, focusedField } from '../src/stream/fields';

describe('scanFields / focusedField (CDP edge cases)', () => {
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
    expect(await focusedField(throws)).toBe(null);
    const exception = new FakeCdp();
    exception.respond('Runtime.evaluate', () => ({ result: {}, exceptionDetails: { text: 'CSP' } }));
    expect(await scanFields(exception)).toEqual([]);
    expect(await focusedField(exception)).toBe(null);
  });

  it('drops anything that is not a well-formed field', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => ({ result: { value: [{ x: 1, y: 2, w: 3, h: 4, kind: 'date' }, 'x', null] } }));
    expect(await scanFields(cdp)).toEqual([]);
    const odd = new FakeCdp();
    odd.respond('Runtime.evaluate', () => ({ result: { value: 'weird' } }));
    expect(await focusedField(odd)).toBe(null);
    const badKind = new FakeCdp();
    badKind.respond('Runtime.evaluate', () => ({ result: { value: { x: 1, y: 2, w: 3, h: 4, kind: 'date', value: 'x' } } }));
    expect(await focusedField(badKind)).toBe(null);
    const extra = new FakeCdp();
    extra.respond('Runtime.evaluate', () => ({ result: { value: { x: 1, y: 2, w: 3, h: 4, kind: 'otp', value: '4' } } }));
    expect(await focusedField(extra)).toEqual({ x: 1, y: 2, w: 3, h: 4, kind: 'otp' }); // never a value
    expect(await scanFields(odd)).toEqual([]);
  });
});
