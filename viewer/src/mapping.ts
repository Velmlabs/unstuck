export interface Size {
  width: number;
  height: number;
}
export interface Rect extends Size {
  left: number;
  top: number;
}

/** Where a page image of `page` size sits inside `box` with object-fit: contain (letterboxed, centred). */
export function fitContain(box: Size, page: Size): Rect {
  if (box.width <= 0 || box.height <= 0 || page.width <= 0 || page.height <= 0) return { left: 0, top: 0, width: 0, height: 0 };
  const scale = Math.min(box.width / page.width, box.height / page.height);
  const width = page.width * scale;
  const height = page.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Maps a pointer position (client CSS px) on the canvas to page CSS px.
 * Uses the canvas CSS rect only, so device pixel ratio never affects it. Null in the letterbox.
 */
export function toPagePoint(client: { x: number; y: number }, canvasRect: Rect, page: Size): { x: number; y: number } | null {
  if (!Number.isFinite(client.x) || !Number.isFinite(client.y)) return null;
  const fit = fitContain(canvasRect, page);
  if (fit.width === 0) return null;
  const lx = client.x - canvasRect.left - fit.left;
  const ly = client.y - canvasRect.top - fit.top;
  const eps = 1e-6;
  if (lx < -eps || ly < -eps || lx > fit.width + eps || ly > fit.height + eps) return null;
  const s = page.width / fit.width;
  return { x: round1(Math.min(page.width, Math.max(0, lx * s))), y: round1(Math.min(page.height, Math.max(0, ly * s))) };
}
