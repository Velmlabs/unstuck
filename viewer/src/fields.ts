// Native typing helpers: which mapped field a tap lands on, where the keyboard bridge sits over the mirror, and how
// far to lift the mirror so the field stays visible above the phone's keyboard.
import type { Field } from '@velmlabs/unstuck-protocol';
import { fitContain, type Rect, type Size } from './mapping';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** iOS treats a tiny input differently (no Backspace repeat): never smaller than this. */
const MIN_W = 44;
const MIN_H = 32;
const STRIP_H = 44;
/** Space left between the field and the top of the keyboard. */
const KEYBOARD_GAP = 12;

/** The field a page point lands in (edges included), or null. */
export function hitField(fields: Field[], p: { x: number; y: number }): Field | null {
  return fields.find((f) => p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h) ?? null;
}

/** Where a field sits over the mirror, in CSS px relative to the mirror's container, exactly (the focus outline). */
export function fieldBox(field: Field, canvas: Rect, page: Size): Box {
  const fit = fitContain(canvas, page);
  const k = fit.width / page.width || 0;
  return {
    left: Math.round(canvas.left + fit.left + field.x * k),
    top: Math.round(canvas.top + fit.top + field.y * k),
    width: Math.round(field.w * k),
    height: Math.round(field.h * k),
  };
}

/**
 * Where the bridge goes: over the field, at least MIN_W×MIN_H (iOS won't repeat a held Backspace in a tiny input),
 * or over the bottom strip of the mirror when there is no field.
 */
export function bridgeBox(field: Field | null, canvas: Rect, page: Size): Box {
  if (!field) return { left: canvas.left, top: canvas.top + canvas.height - STRIP_H, width: canvas.width, height: STRIP_H };
  const box = fieldBox(field, canvas, page);
  return { ...box, width: Math.max(MIN_W, box.width), height: Math.max(MIN_H, box.height) };
}

/** How many px to move the mirror up so `box` (relative to a container at `containerTop`) sits above the keyboard. */
export function liftOffset(box: Pick<Box, 'top' | 'height'>, visibleHeight: number, containerTop: number): number {
  if (visibleHeight <= 0) return 0;
  const bottom = containerTop + box.top + box.height;
  return Math.max(0, bottom - (visibleHeight - KEYBOARD_GAP));
}
