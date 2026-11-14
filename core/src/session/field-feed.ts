// Keeps the viewer's field map current: scans on frames (at most every 500 ms), right after inputs that can move or
// focus things (tap, scroll, key), and when the shown target changes; reports focus after taps. Sends a map only when
// it changed, re-sends it every 5 s in case one was dropped, and never sends an empty map nobody needs.
import type { EngineToViewer, Field, ViewerInput } from '@velmlabs/unstuck-protocol';

export interface FieldFeed {
  onFrame(): void;
  onInput(msg: ViewerInput): void;
  /** The viewer or the shown target changed: scan now and send even an unchanged map. */
  onTargetChanged(): void;
  stop(): void;
}

const FRAME_INTERVAL_MS = 500;
const RESEND_MS = 5000;

export function createFieldFeed(deps: { scan: () => Promise<Field[]>; focus: () => Promise<Field | null>; send: (m: EngineToViewer) => void }): FieldFeed {
  let stopped = false;
  let lastScanAt = -Infinity;
  let last: Field[] = [];
  let lastJson = '[]';
  // One scan at a time: triggers while it runs mark the map dirty and get exactly one more scan afterwards, so a slow
  // page (or a remote browser) is never starved and a trackpad's 60 wheel events a second cost one or two scans.
  let inFlight = false;
  let dirty = false;
  /** A forced send (viewer joined, target changed) sticks until a scan has run with it. */
  let pendingForce = false;
  let trailing: ReturnType<typeof setTimeout> | null = null;

  const run = (): void => {
    if (stopped) return;
    if (inFlight) return void (dirty = true);
    inFlight = true;
    lastScanAt = Date.now();
    const force = pendingForce;
    pendingForce = false;
    deps
      .scan()
      .then((fields) => {
        if (stopped) return;
        const json = JSON.stringify(fields);
        if (json === lastJson && !(force && fields.length > 0)) return;
        last = fields;
        lastJson = json;
        deps.send({ t: 'fields', fields });
      })
      .catch(() => {}) // a page mid-navigation: the next trigger scans again
      .finally(() => {
        inFlight = false;
        if (dirty) {
          dirty = false;
          run();
        }
      });
  };

  /** Scans now, or (frames within 500 ms of the last scan) once the window ends, so a page that settles is seen. */
  const request = (immediate: boolean, force = false): void => {
    if (stopped) return;
    if (force) pendingForce = true;
    const wait = lastScanAt + FRAME_INTERVAL_MS - Date.now();
    if (immediate || wait <= 0) return run();
    trailing ??= setTimeout(() => {
      trailing = null;
      run();
    }, wait);
  };

  const resend = setInterval(() => {
    if (!stopped && last.length > 0) deps.send({ t: 'fields', fields: last });
  }, RESEND_MS);

  return {
    onFrame() {
      request(false);
    },
    onInput(msg) {
      if (stopped) return;
      const tap = msg.t === 'mouse' && msg.action === 'up';
      const typed = (msg.t === 'key' && msg.action === 'down') || msg.t === 'text';
      if (!(tap || typed || msg.t === 'wheel')) return;
      request(true);
      // After taps and typing: what has focus now, and where (a widget may move focus to its next box as you type).
      if (tap || typed)
        deps
          .focus()
          .then((field) => void (stopped || deps.send(field ? { t: 'focus', kind: field.kind, field } : { t: 'focus', kind: null })))
          .catch(() => {});
    },
    onTargetChanged() {
      request(true, true);
    },
    stop() {
      stopped = true;
      clearInterval(resend);
      if (trailing) clearTimeout(trailing);
    },
  };
}
