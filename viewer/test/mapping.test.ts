import { describe, it, expect } from 'vitest';
import { FIT_VIEW, MAX_ZOOM, NO_INSET, clampToPage, clampView, fitContain, imageRect, isFit, pinchView, sizeChangedALot, toClientPoint, toPagePoint, viewTransform, visiblePageRect, zoomAt } from '../src/mapping';

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

describe('clampToPage (Final I3)', () => {
  it('clamps points in the letterbox or outside the canvas to the nearest page edge', () => {
    expect(clampToPage({ x: 195, y: 100 }, rect(0, 0, 390, 844), page)).toEqual({ x: 640, y: 0 });
    expect(clampToPage({ x: 500, y: 422 }, rect(0, 0, 390, 844), page)).toEqual({ x: 1280, y: 360 });
    expect(clampToPage({ x: -50, y: 900 }, rect(0, 0, 390, 844), page)).toEqual({ x: 0, y: 720 });
  });

  it('returns null when the page size is unknown or the coordinates are not finite', () => {
    expect(clampToPage({ x: 1, y: 1 }, rect(0, 0, 390, 844), { width: 0, height: 0 })).toBeNull();
    expect(clampToPage({ x: Number.NaN, y: 1 }, rect(0, 0, 390, 844), page)).toBeNull();
  });
});


describe('zoom and pan (the view)', () => {
  // A 1280×800 desktop page on a 390×600 phone stage: fit is 390×243.75, letterboxed 178.1 px top and bottom.
  const box = rect(0, 100, 390, 600);
  const desk = { width: 1280, height: 800 };
  const k = 390 / 1280;

  it('at fit, behaves exactly like the unzoomed mapping', () => {
    expect(imageRect(box, desk, FIT_VIEW)).toEqual({ left: 0, top: 100 + (600 - 800 * k) / 2, width: 390, height: 800 * k });
    expect(toPagePoint({ x: 195, y: 400 }, box, desk, FIT_VIEW)).toEqual(toPagePoint({ x: 195, y: 400 }, box, desk));
    expect(isFit(FIT_VIEW)).toBe(true);
    expect(viewTransform(FIT_VIEW)).toBe('');
  });

  it('maps client points to page points at several zoom and pan values', () => {
    // 2× around the stage centre: the page centre stays under the stage centre.
    const v2 = zoomAt(FIT_VIEW, { x: 195, y: 400 }, 2, box, desk);
    expect(v2.scale).toBe(2);
    expect(toPagePoint({ x: 195, y: 400 }, box, desk, v2)).toEqual({ x: 640, y: 400 });
    // One CSS px on the phone is now half as many page px as at fit.
    const a = toPagePoint({ x: 195, y: 400 }, box, desk, v2)!;
    const b = toPagePoint({ x: 205, y: 400 }, box, desk, v2)!;
    expect(b.x - a.x).toBeCloseTo(10 / (2 * k), 0);
    // 4× around the top-left of the image: the image is now taller than the stage, so the pan clamp pulls the page's
    // top edge up to the stage's top edge (no black band above it), and the page's top-left sits at the stage's.
    const top = imageRect(box, desk, FIT_VIEW).top;
    const v4 = zoomAt(FIT_VIEW, { x: 0, y: top }, 4, box, desk);
    expect(toPagePoint({ x: 0, y: box.top }, box, desk, v4)).toEqual({ x: 0, y: 0 });
    expect(toPagePoint({ x: 390, y: box.top }, box, desk, v4)).toEqual({ x: 320, y: 0 });
    expect(viewTransform(v4)).toMatch(/^translate\(.+px, .+px\) scale\(4\)$/);
  });

  it('round-trips page → client → page at any view', () => {
    const views = [FIT_VIEW, zoomAt(FIT_VIEW, { x: 100, y: 300 }, 1.7, box, desk), zoomAt(FIT_VIEW, { x: 300, y: 500 }, 4, box, desk)];
    for (const v of views) {
      for (const p of [{ x: 640, y: 400 }, { x: 100, y: 700 }]) {
        const c = toClientPoint(p, box, desk, v);
        const back = toPagePoint(c, box, desk, v);
        if (back) expect(back).toEqual(p); // off-screen points (outside the stage) are not on the visible image
        expect(clampToPage(c, box, desk, v)).toEqual(p);
      }
    }
  });

  it('a tap outside the zoomed image is ignored; release clamps to the page edge', () => {
    const v = zoomAt(FIT_VIEW, { x: 195, y: 400 }, 2, box, desk); // image 780×487.5, still letterboxed vertically
    const img = imageRect(box, desk, v);
    expect(img.height).toBeCloseTo(487.5);
    expect(toPagePoint({ x: 195, y: img.top - 5 }, box, desk, v)).toBeNull();
    expect(clampToPage({ x: 195, y: img.top - 5 }, box, desk, v)).toEqual({ x: 640, y: 0 });
  });

  it('clamps the zoom to fit..4× and the pan so the page never leaves the screen (no gaps beyond the letterbox)', () => {
    expect(zoomAt(FIT_VIEW, { x: 195, y: 400 }, 0.3, box, desk)).toEqual(FIT_VIEW);
    expect(zoomAt(FIT_VIEW, { x: 195, y: 400 }, 40, box, desk).scale).toBe(MAX_ZOOM);
    // Panned far off to the right/bottom: the image's left edge is pulled back to the stage's left edge.
    const far = clampView({ scale: 2, x: 5000, y: 5000 }, box, desk);
    const img = imageRect(box, desk, far);
    expect(img.left).toBe(box.left);
    // Narrower than the stage vertically: centred.
    expect(img.top - box.top).toBeCloseTo((600 - img.height) / 2);
    const left = imageRect(box, desk, clampView({ scale: 2, x: -5000, y: 0 }, box, desk));
    expect(left.left + left.width).toBeCloseTo(box.left + box.width);
    // Taller than the stage: edges pulled back to the stage's top/bottom.
    const tall = imageRect(box, desk, clampView({ scale: 4, x: 0, y: 5000 }, box, desk));
    expect(tall.top).toBeCloseTo(box.top);
    const tall2 = imageRect(box, desk, clampView({ scale: 4, x: 0, y: -5000 }, box, desk));
    expect(tall2.top + tall2.height).toBeCloseTo(box.top + box.height);
    expect(clampView({ scale: Number.NaN, x: 1, y: 1 }, box, desk)).toEqual(FIT_VIEW);
    expect(clampView({ scale: 2, x: 1, y: 1 }, box, { width: 0, height: 0 })).toEqual(FIT_VIEW);
  });

  it('when zoomed, the page can pan out past the right and bottom edges by the controls inset, never at fit', () => {
    const inset = { right: 56, bottom: 270 };
    // 2×: image 780×487.5 in 390×600. Horizontally it may now end 56 px short of the right edge.
    const far = imageRect(box, desk, clampView({ scale: 2, x: -5000, y: -5000 }, box, desk, inset));
    expect(far.left + far.width).toBeCloseTo(box.left + box.width - 56);
    // Vertically it is narrower than the box: centred, or up to 270 px higher, never lower.
    const centred = (600 - far.height) / 2;
    expect(far.top - box.top).toBeCloseTo(centred - 270);
    const low = imageRect(box, desk, clampView({ scale: 2, x: 0, y: 5000 }, box, desk, inset));
    expect(low.top - box.top).toBeCloseTo(centred);
    expect(low.left).toBe(box.left);
    // The usual range is unchanged inside the inset.
    const v = zoomAt(FIT_VIEW, { x: 195, y: 400 }, 2, box, desk, inset);
    expect(v).toEqual(zoomAt(FIT_VIEW, { x: 195, y: 400 }, 2, box, desk, NO_INSET));
    expect(pinchView(FIT_VIEW, { mid: { x: 195, y: 400 }, dist: 100 }, { mid: { x: 100, y: 100 }, dist: 400 }, box, desk, inset).scale).toBe(4);
    // At fit the inset is ignored: fit is always exactly centred.
    expect(clampView({ scale: 1, x: -40, y: -40 }, box, desk, inset)).toEqual(FIT_VIEW);
  });

  it('a pinch zooms around its centre and a moving centre pans', () => {
    const start = { mid: { x: 195, y: 400 }, dist: 100 };
    const under = toPagePoint(start.mid, box, desk, FIT_VIEW)!;
    const v = pinchView(FIT_VIEW, start, { mid: { x: 195, y: 400 }, dist: 250 }, box, desk);
    expect(v.scale).toBeCloseTo(2.5);
    expect(toPagePoint({ x: 195, y: 400 }, box, desk, v)).toEqual(under);
    // Both fingers move 30 px left at the same spread: the same page point follows the fingers.
    const panned = pinchView(FIT_VIEW, start, { mid: { x: 165, y: 400 }, dist: 250 }, box, desk);
    expect(toPagePoint({ x: 165, y: 400 }, box, desk, panned)).toEqual(under);
    // Pinching in past fit stays at fit.
    expect(pinchView(v, { mid: { x: 195, y: 400 }, dist: 250 }, { mid: { x: 195, y: 400 }, dist: 10 }, box, desk)).toEqual(FIT_VIEW);
    // A degenerate start (two pointers on the same spot) keeps the view.
    expect(pinchView(v, { mid: { x: 195, y: 400 }, dist: 0 }, { mid: { x: 195, y: 400 }, dist: 50 }, box, desk)).toEqual(v);
  });

  it('the visible part of the page: all of it at fit, the centre quarter at 2× in a box the image fills', () => {
    expect(visiblePageRect(box, desk, FIT_VIEW)).toEqual({ left: 0, top: 0, width: 1280, height: 800 });
    const sq = rect(0, 0, 640, 400);
    const v = zoomAt(FIT_VIEW, { x: 320, y: 200 }, 2, sq, desk);
    expect(visiblePageRect(sq, desk, v)).toEqual({ left: 320, top: 200, width: 640, height: 400 });
    expect(visiblePageRect(sq, { width: 0, height: 0 }, v)).toEqual({ left: 0, top: 0, width: 0, height: 0 });
  });

  it('only a big page size change (another page, a popup) counts as a new page', () => {
    expect(sizeChangedALot({ width: 1280, height: 800 }, { width: 1280, height: 800 })).toBe(false);
    expect(sizeChangedALot({ width: 1280, height: 800 }, { width: 1265, height: 790 })).toBe(false); // a scrollbar
    expect(sizeChangedALot({ width: 1280, height: 800 }, { width: 500, height: 600 })).toBe(true); // a popup
    expect(sizeChangedALot({ width: 1280, height: 800 }, { width: 1280, height: 400 })).toBe(true);
    expect(sizeChangedALot({ width: 0, height: 0 }, { width: 1280, height: 800 })).toBe(false); // the first frame
  });
});
