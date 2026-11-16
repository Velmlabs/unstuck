// Every conversion between the phone's screen (client CSS px) and the agent's page (page CSS px) lives here, zoom
// and pan included: taps, drags, wheel, the scroll buttons and the keyboard bridge over a field all go through it.
//
// The page image is drawn into the canvas at the frame's own resolution and shown with object-fit: contain inside
// the mirror's box (the viewport). Zoom is a CSS transform on the canvas, `translate(x, y) scale(s)` with origin 0 0,
// relative to that untransformed box: the browser samples the full-resolution frame directly, so a zoomed frame is
// as crisp as the frame itself, and the maths below is the same affine map the compositor applies, so taps are exact.
export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Size {
  left: number;
  top: number;
}
export interface Point {
  x: number;
  y: number;
}
/** Zoom and pan: the canvas is shown at `scale`× fit, moved by (x, y) CSS px within the mirror's box. */
export interface View {
  scale: number;
  x: number;
  y: number;
}

/** Room on the right and bottom of the box that on-screen controls cover: when zoomed, the page may pan out past
 * the box edge by this much, so whatever sits under the controls can be brought out from under them. */
export interface Inset {
  right: number;
  bottom: number;
}
export const NO_INSET: Inset = Object.freeze({ right: 0, bottom: 0 });

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const FIT_VIEW: View = Object.freeze({ scale: 1, x: 0, y: 0 });

/** Where a page image of `page` size sits inside `box` with object-fit: contain (letterboxed, centred). */
export function fitContain(box: Size, page: Size): Rect {
  if (box.width <= 0 || box.height <= 0 || page.width <= 0 || page.height <= 0) return { left: 0, top: 0, width: 0, height: 0 };
  const scale = Math.min(box.width / page.width, box.height / page.height);
  const width = page.width * scale;
  const height = page.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Where the page image appears on screen (same coordinates as `box`) at a zoom and pan. */
export function imageRect(box: Rect, page: Size, view: View = FIT_VIEW): Rect {
  const fit = fitContain(box, page);
  const s = view.scale;
  return { left: box.left + view.x + s * fit.left, top: box.top + view.y + s * fit.top, width: s * fit.width, height: s * fit.height };
}

/**
 * Maps a pointer position (client CSS px) on the mirror to page CSS px, at the current zoom and pan.
 * Uses CSS rects only, so device pixel ratio never affects it. Null outside the page image (the letterbox).
 * `box` is the mirror's untransformed box.
 */
export function toPagePoint(client: Point, box: Rect, page: Size, view: View = FIT_VIEW): Point | null {
  if (!Number.isFinite(client.x) || !Number.isFinite(client.y)) return null;
  const img = imageRect(box, page, view);
  if (img.width === 0) return null;
  const lx = client.x - img.left;
  const ly = client.y - img.top;
  const eps = 1e-6;
  if (lx < -eps || ly < -eps || lx > img.width + eps || ly > img.height + eps) return null;
  const s = page.width / img.width;
  return { x: round1(Math.min(page.width, Math.max(0, lx * s))), y: round1(Math.min(page.height, Math.max(0, ly * s))) };
}

/** Like toPagePoint, but clamps points outside the page image (letterbox, off-canvas) to the nearest edge. */
export function clampToPage(client: Point, box: Rect, page: Size, view: View = FIT_VIEW): Point | null {
  if (!Number.isFinite(client.x) || !Number.isFinite(client.y)) return null;
  const img = imageRect(box, page, view);
  if (img.width === 0) return null;
  const s = page.width / img.width;
  const lx = (client.x - img.left) * s;
  const ly = (client.y - img.top) * s;
  return { x: round1(Math.min(page.width, Math.max(0, lx))), y: round1(Math.min(page.height, Math.max(0, ly))) };
}

/** Where a page point appears on screen (the inverse of toPagePoint). */
export function toClientPoint(p: Point, box: Rect, page: Size, view: View = FIT_VIEW): Point {
  const img = imageRect(box, page, view);
  const k = img.width / page.width || 0;
  return { x: img.left + p.x * k, y: img.top + p.y * k };
}

/**
 * Keeps a view in range: zoom between fit and MAX_ZOOM, and the pan such that the page image covers the box on every
 * axis where it is bigger than the box, and is centred where it is smaller. So the page never leaves the screen, and
 * no black band ever appears beyond the letterbox fit already has, except, when zoomed, up to `inset` on the right and
 * bottom (the controls' corner), so nothing on the page stays stuck under the buttons.
 */
export function clampView(view: View, box: Size, page: Size, inset: Inset = NO_INSET): View {
  const fit = fitContain(box, page);
  if (!Number.isFinite(view.scale) || fit.width === 0) return FIT_VIEW;
  const s = clamp(view.scale, MIN_ZOOM, MAX_ZOOM);
  const zoomed = s > MIN_ZOOM;
  const axis = (t: number, boxLen: number, fitStart: number, fitLen: number, over: number) => {
    const len = s * fitLen;
    const centre = (boxLen - len) / 2;
    const hi = Math.max(0, centre);
    const lo = Math.min(boxLen - len, centre) - (zoomed ? Math.max(0, over) : 0);
    const start = lo >= hi - 1e-6 ? hi : clamp((Number.isFinite(t) ? t : 0) + s * fitStart, lo, hi);
    return start - s * fitStart || 0; // never -0
  };
  return { scale: s, x: axis(view.x, box.width, fit.left, fit.width, inset.right), y: axis(view.y, box.height, fit.top, fit.height, inset.bottom) };
}

/** Zooms to `scale` keeping the page point under `focal` (client px) where it is, then clamps. */
export function zoomAt(view: View, focal: Point, scale: number, box: Rect, page: Size, inset: Inset = NO_INSET): View {
  const s = clamp(scale, MIN_ZOOM, MAX_ZOOM);
  const fx = focal.x - box.left;
  const fy = focal.y - box.top;
  return clampView({ scale: s, x: fx - ((fx - view.x) / view.scale) * s, y: fy - ((fy - view.y) / view.scale) * s }, box, page, inset);
}

/** Two fingers: where they started (midpoint and spread) and where they are now, from the view at the start. */
export interface Pinch {
  mid: Point;
  dist: number;
}

/**
 * A pinch: the zoom follows the fingers' spread and the page point that was under their midpoint stays under it,
 * so moving both fingers together pans.
 */
export function pinchView(start: View, from: Pinch, to: Pinch, box: Rect, page: Size, inset: Inset = NO_INSET): View {
  if (!(from.dist > 0)) return start;
  const s = clamp((start.scale * to.dist) / from.dist, MIN_ZOOM, MAX_ZOOM);
  const lx = (from.mid.x - box.left - start.x) / start.scale;
  const ly = (from.mid.y - box.top - start.y) / start.scale;
  return clampView({ scale: s, x: to.mid.x - box.left - lx * s, y: to.mid.y - box.top - ly * s }, box, page, inset);
}

/** The part of the page that is on screen, in page px (all of it at fit). */
export function visiblePageRect(box: Rect, page: Size, view: View = FIT_VIEW): Rect {
  const img = imageRect(box, page, view);
  const k = img.width / page.width || 0;
  if (!k) return { left: 0, top: 0, width: 0, height: 0 };
  const left = Math.max(0, (box.left - img.left) / k);
  const top = Math.max(0, (box.top - img.top) / k);
  const right = Math.min(page.width, (box.left + box.width - img.left) / k);
  const bottom = Math.min(page.height, (box.top + box.height - img.top) / k);
  return { left: round1(left), top: round1(top), width: round1(right - left), height: round1(bottom - top) };
}

export const isFit = (v: View) => v.scale <= MIN_ZOOM;

/** The CSS transform that shows the canvas at a view (none at fit). */
export function viewTransform(v: View): string {
  if (isFit(v)) return '';
  const r = (n: number) => Math.round(n * 1000) / 1000;
  return `translate(${r(v.x)}px, ${r(v.y)}px) scale(${r(v.scale)})`;
}

/** Another page (navigation to a different-size page, a popup): more than 15% change on either side. */
export function sizeChangedALot(before: Size, after: Size): boolean {
  if (before.width <= 0 || before.height <= 0) return false;
  return Math.abs(after.width - before.width) / before.width > 0.15 || Math.abs(after.height - before.height) / before.height > 0.15;
}
