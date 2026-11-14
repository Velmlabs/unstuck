// Finds the fields a person can type into on the page shown to them, so the viewer can open the right keyboard on
// the first tap. Only boxes and kinds leave the page, never a field's value. Runs inside the page via
// Runtime.evaluate; the in-page code is plain JavaScript text so no bundler helper can leak into it.
import { FieldKinds, type Field, type FieldKind } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';

/** In-page: the kind of a typable element, or null. Shared by both scripts. */
const KIND_OF = `function kindOf(el) {
  if (!el || el.nodeType !== 1 || el.disabled || el.readOnly) return null;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return 'text';
  if (tag !== 'INPUT') return el.isContentEditable ? 'text' : null;
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  if (!['text', 'tel', 'number', 'email', 'password', 'search', 'url'].includes(type)) return null;
  const im = (el.getAttribute('inputmode') || '').toLowerCase();
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
  if (ac.includes('one-time-code')) return 'otp';
  if (type === 'password') return 'password';
  if (type === 'tel' || type === 'number' || ['numeric', 'decimal', 'tel'].includes(im)) return 'numeric';
  if (type === 'email' || im === 'email') return 'email';
  return 'text';
}`;

/** In-page: visible, uncovered typable fields of the top document, same-origin iframes and open shadow roots. */
export const SCAN_SOURCE = `(() => {
  ${KIND_OF}
  const vw = innerWidth, vh = innerHeight, found = [];
  const inside = (a, b) => b.left >= a.left - 1 && b.top >= a.top - 1 && b.right <= a.right + 1 && b.bottom <= a.bottom + 1;
  // Something else on top of the field's visible centre means a tap there doesn't reach it.
  const uncovered = (el, r, root, ox, oy) => {
    const cx = Math.min(Math.max((Math.max(r.left, -ox) + Math.min(r.right, vw - ox)) / 2, 0), vw);
    const cy = Math.min(Math.max((Math.max(r.top, -oy) + Math.min(r.bottom, vh - oy)) / 2, 0), vh);
    const hit = root.elementFromPoint ? root.elementFromPoint(cx, cy) : null;
    if (!hit) return false;
    return hit === el || el.contains(hit) || inside(r, hit.getBoundingClientRect());
  };
  const walk = (root, ox, oy, frameOk) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot, ox, oy, frameOk);
      if (el.tagName === 'IFRAME') {
        let doc = null;
        try { doc = el.contentDocument; } catch (e) { doc = null; }
        if (doc) {
          const fr = el.getBoundingClientRect();
          const nx = ox + fr.left + el.clientLeft, ny = oy + fr.top + el.clientTop;
          walk(doc, nx, ny, (x, y) => frameOk(x, y) && document.elementFromPoint(x, y) === el);
        }
        continue;
      }
      const kind = kindOf(el);
      if (!kind) continue;
      const style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const x = r.left + ox, y = r.top + oy;
      if (x >= vw || y >= vh || x + r.width <= 0 || y + r.height <= 0) continue;
      if (!uncovered(el, r, el.getRootNode(), ox, oy)) continue;
      if (!frameOk(x + r.width / 2, y + r.height / 2)) continue;
      found.push({ x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height), kind });
    }
  };
  walk(document, 0, 0, () => true);
  const d = (f) => Math.hypot(f.x + f.w / 2 - vw / 2, f.y + f.h / 2 - vh / 2);
  return found.sort((a, b) => d(a) - d(b)).slice(0, 30);
})()`;

/** In-page: the focused field and its box (through shadow roots and same-origin frames, offset by each frame), a
 * focused cross-origin frame as a text field with the frame's box (a field there is the likely case), or null. */
export const FOCUS_SOURCE = `(() => {
  ${KIND_OF}
  const box = (r, kind, ox, oy) => ({ x: Math.round(r.left + ox), y: Math.round(r.top + oy), w: Math.round(r.width), h: Math.round(r.height), kind });
  let el = document.activeElement, ox = 0, oy = 0;
  for (let i = 0; el && i < 20; i++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === 'IFRAME') {
      let doc = null;
      try { doc = el.contentDocument; } catch (e) { doc = null; }
      const fr = el.getBoundingClientRect();
      if (!doc) return box(fr, 'text', ox, oy);
      ox += fr.left + el.clientLeft;
      oy += fr.top + el.clientTop;
      el = doc.activeElement;
      continue;
    }
    break;
  }
  const kind = kindOf(el);
  return kind ? box(el.getBoundingClientRect(), kind, ox, oy) : null;
})()`;

const isKind = (k: unknown): k is FieldKind => (FieldKinds as readonly unknown[]).includes(k);
const isField = (f: unknown): f is Field => {
  const o = f as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(o[k])) && isKind(o.kind);
};

async function evaluate(cdp: CdpClient, expression: string): Promise<unknown> {
  try {
    const r = await cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true });
    return r.exceptionDetails ? undefined : r.result?.value;
  } catch {
    return undefined;
  }
}

/** The typable fields visible on the page, nearest the centre first (at most 30). Never throws: [] on any error. */
export async function scanFields(cdp: CdpClient): Promise<Field[]> {
  const v = await evaluate(cdp, SCAN_SOURCE);
  return Array.isArray(v) ? v.filter(isField).map(({ x, y, w, h, kind }) => ({ x, y, w, h, kind })) : [];
}

/** The focused field with its box (never its value), or null. Never throws. */
export async function focusedField(cdp: CdpClient): Promise<Field | null> {
  const v = await evaluate(cdp, FOCUS_SOURCE);
  return isField(v) ? { x: v.x, y: v.y, w: v.w, h: v.h, kind: v.kind } : null;
}
