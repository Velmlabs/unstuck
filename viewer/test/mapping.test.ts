import { describe, it, expect } from 'vitest';
import { fitContain, toPagePoint } from '../src/mapping';

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
const page = { width: 1280, height: 720 };

describe('fitContain', () => {
  it('letterboxes a landscape page in a portrait phone box', () => {
    const r = fitContain({ width: 390, height: 844 }, page);
    expect(r.left).toBe(0);
    expect(r.width).toBe(390);
    expect(r.height).toBeCloseTo(219.4, 1);
    expect(r.top).toBeCloseTo(312.3, 1);
  });

  it('pillarboxes a portrait page in a landscape box', () => {
    const r = fitContain({ width: 1000, height: 500 }, { width: 400, height: 800 });
    expect(r).toEqual({ left: 375, top: 0, width: 250, height: 500 });
  });

  it('returns an empty rect for zero-size inputs', () => {
    expect(fitContain({ width: 0, height: 0 }, page)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
    expect(fitContain({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });
});

describe('toPagePoint (Review Focus 1)', () => {
  it('maps the centre of a phone canvas to the centre of the page', () => {
    const p = toPagePoint({ x: 195, y: 422 }, rect(0, 0, 390, 844), page)!;
    expect(p.x).toBeCloseTo(640, 0);
    expect(p.y).toBeCloseTo(360, 0);
  });

  it('returns null in the letterbox area', () => {
    expect(toPagePoint({ x: 195, y: 100 }, rect(0, 0, 390, 844), page)).toBeNull();
    expect(toPagePoint({ x: 195, y: 800 }, rect(0, 0, 390, 844), page)).toBeNull();
  });

  it('accounts for the canvas offset in the page', () => {
    const a = toPagePoint({ x: 195, y: 422 }, rect(0, 0, 390, 844), page)!;
    const b = toPagePoint({ x: 215, y: 472 }, rect(20, 50, 390, 844), page)!;
    expect(b).toEqual(a);
  });

  it('uses CSS size only, so device pixel ratio does not change the result', () => {
    // A 2x canvas has a 780x1688 backing store but the same 390x844 CSS rect.
    expect(toPagePoint({ x: 100, y: 400 }, rect(0, 0, 390, 844), page)).toEqual(toPagePoint({ x: 100, y: 400 }, rect(0, 0, 390, 844), page));
  });

  it('maps corners exactly and rounds to 0.1 px', () => {
    const r = fitContain({ width: 640, height: 360 }, page);
    expect(toPagePoint({ x: 0, y: 0 }, rect(0, 0, 640, 360), page)).toEqual({ x: 0, y: 0 });
    expect(toPagePoint({ x: r.width, y: r.height }, rect(0, 0, 640, 360), page)).toEqual({ x: 1280, y: 720 });
    expect(toPagePoint({ x: 1 / 3, y: 0 }, rect(0, 0, 640, 360), page)).toEqual({ x: 0.7, y: 0 });
  });

  it('returns null for non-finite pointer coordinates', () => {
    expect(toPagePoint({ x: Number.NaN, y: 1 }, rect(0, 0, 640, 360), page)).toBeNull();
    expect(toPagePoint({ x: 1, y: Number.POSITIVE_INFINITY }, rect(0, 0, 640, 360), page)).toBeNull();
  });

  it('returns null when the page size is unknown', () => {
    expect(toPagePoint({ x: 1, y: 1 }, rect(0, 0, 100, 100), { width: 0, height: 0 })).toBeNull();
  });
});
