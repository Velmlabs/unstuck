// Keeps the viewer's field map current: scans on frames (at most every 500 ms), right after inputs that can move or
// focus things (tap, scroll, key), and when the shown target changes; reports focus after taps. Sends a map only when
// it changed, re-sends it every 5 s in case one was dropped, and never sends an empty map nobody needs.
import type { EngineToViewer, Field, FieldKind, ViewerInput } from '@velmlabs/unstuck-protocol';

export interface FieldFeed {
  onFrame(): void;
  onInput(msg: ViewerInput): void;
  /** The viewer or the shown target changed: scan now and send even an unchanged map. */
  onTargetChanged(): void;
  stop(): void;
}

const FRAME_INTERVAL_MS = 500;
const RESEND_MS = 5000;

export function createFieldFeed(deps: { scan: () => Promise<Field[]>; focus: () => Promise<FieldKind | null>; send: (m: EngineToViewer) => void }): FieldFeed {
  let stopped = false;
  let lastScanAt = -Infinity;
  let last: Field[] = [];
  let lastJson = '[]';
  let gen = 0;

  const scan = (force: boolean): void => {
    lastScanAt = Date.now();
    const mine = ++gen;
    deps
      .scan()
      .then((fields) => {
        if (stopped || mine !== gen) return; // a newer scan supersedes this one
        const json = JSON.stringify(fields);
        const changed = json !== lastJson;
        if (!changed && !(force && fields.length > 0)) return;
        last = fields;
        lastJson = json;
        deps.send({ t: 'fields', fields });
      })
      .catch(() => {}); // a page mid-navigation: the next trigger scans again
  };

  const resend = setInterval(() => {
    if (!stopped && last.length > 0) deps.send({ t: 'fields', fields: last });
  }, RESEND_MS);

  return {
    onFrame() {
      if (!stopped && Date.now() - lastScanAt >= FRAME_INTERVAL_MS) scan(false);
    },
    onInput(msg) {
      if (stopped) return;
      const tap = msg.t === 'mouse' && msg.action === 'up';
      if (!(tap || msg.t === 'wheel' || (msg.t === 'key' && msg.action === 'down') || msg.t === 'text')) return;
      scan(false);
      if (tap)
        deps
          .focus()
          .then((kind) => void (stopped || deps.send({ t: 'focus', kind })))
          .catch(() => {});
    },
    onTargetChanged() {
      if (!stopped) scan(true);
    },
    stop() {
      stopped = true;
      clearInterval(resend);
    },
  };
}
