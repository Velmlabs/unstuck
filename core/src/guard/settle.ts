import type { CdpClient } from '../cdp';

export const NAV_GRACE_MS = 250;
export const LOAD_WAIT_MS = 10_000;
export const SETTLE_QUIET_MS = 1_000;
export const SETTLE_MAX_MS = 10_000;

async function mainFrameId(cdp: CdpClient): Promise<string | undefined> {
  try {
    return (await cdp.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree')).frameTree?.frame?.id;
  } catch {
    return undefined;
  }
}

/** True if the main frame starts navigating within `graceMs`; then waits for its load (at most `loadMs`). */
export async function waitForNavigation(cdp: CdpClient, graceMs = NAV_GRACE_MS, loadMs = LOAD_WAIT_MS): Promise<boolean> {
  const main = await mainFrameId(cdp);
  const isMain = (p: { frameId?: string }) => main === undefined || p.frameId === main;
  let started = false;
  let loaded!: () => void;
  const load = new Promise<void>((r) => (loaded = r));
  const offs = [
    cdp.on('Page.frameStartedLoading', (p) => isMain(p) && (started = true)),
    cdp.on('Page.frameRequestedNavigation', (p) => isMain(p) && (started = true)),
    cdp.on('Page.loadEventFired', () => started && loaded()),
  ];
  try {
    await new Promise((r) => setTimeout(r, graceMs));
    if (!started) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([load, new Promise<void>((r) => (timer = setTimeout(r, loadMs)))]);
    clearTimeout(timer);
    return true;
  } finally {
    for (const off of offs) off();
  }
}

/** Resolves once the main frame has been quiet (no navigation or load) for `quietMs`, or after `maxMs`. */
export async function waitForQuiet(cdp: CdpClient, quietMs = SETTLE_QUIET_MS, maxMs = SETTLE_MAX_MS): Promise<void> {
  const main = await mainFrameId(cdp);
  const isMain = (p: { frameId?: string; frame?: { id?: string } }) => main === undefined || (p.frameId ?? p.frame?.id) === main;
  await new Promise<void>((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    // A navigation in flight is never "quiet": the timer only runs again once its load has fired.
    let loading = false;
    const done = () => {
      clearTimeout(quiet);
      clearTimeout(cap);
      for (const off of offs) off();
      resolve();
    };
    const restart = () => {
      clearTimeout(quiet);
      if (!loading) quiet = setTimeout(done, quietMs);
    };
    const navigating = () => {
      loading = true;
      restart();
    };
    const cap = setTimeout(done, maxMs);
    const offs = [
      cdp.on('Page.frameStartedLoading', (p) => isMain(p) && navigating()),
      cdp.on('Page.frameRequestedNavigation', (p) => isMain(p) && navigating()),
      cdp.on('Page.frameNavigated', (p) => isMain(p) && restart()),
      cdp.on('Page.loadEventFired', () => {
        loading = false;
        restart();
      }),
    ];
    restart();
  });
}
