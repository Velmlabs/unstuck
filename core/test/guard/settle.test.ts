import { describe, it, expect } from 'vitest';
import { waitForNavigation, waitForQuiet, NAV_GRACE_MS, LOAD_WAIT_MS, SETTLE_QUIET_MS, SETTLE_MAX_MS } from '../../src/guard/settle';
import { FakeCdp } from '../../src/testing/fake-cdp';

const main = () => {
  const cdp = new FakeCdp();
  cdp.respond('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'MAIN' } } }));
  return cdp;
};
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

describe('settle', () => {
  it('has the documented defaults', () => {
    expect([NAV_GRACE_MS, LOAD_WAIT_MS, SETTLE_QUIET_MS, SETTLE_MAX_MS]).toEqual([250, 10_000, 1_000, 10_000]);
  });

  it('waitForNavigation is false when nothing navigates within the grace period', async () => {
    await expect(waitForNavigation(main(), 20, 200)).resolves.toBe(false);
  });

  it('waitForNavigation waits for the load after a main-frame navigation starts', async () => {
    const cdp = main();
    const t0 = Date.now();
    later(5, () => cdp.emit('Page.frameStartedLoading', { frameId: 'MAIN' }));
    later(80, () => cdp.emit('Page.loadEventFired', {}));
    await expect(waitForNavigation(cdp, 40, 2000)).resolves.toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(75);
  });

  it('a child frame loading is not a navigation; the load wait is bounded', async () => {
    const cdp = main();
    later(5, () => cdp.emit('Page.frameStartedLoading', { frameId: 'CHILD' }));
    await expect(waitForNavigation(cdp, 30, 50)).resolves.toBe(false);
    const cdp2 = main();
    later(5, () => cdp2.emit('Page.frameRequestedNavigation', { frameId: 'MAIN' }));
    await expect(waitForNavigation(cdp2, 30, 50)).resolves.toBe(true);
  });

  it('waitForQuiet resolves after a quiet period, restarting on main-frame activity', async () => {
    const cdp = main();
    const t0 = Date.now();
    later(30, () => cdp.emit('Page.frameStartedLoading', { frameId: 'MAIN' }));
    later(60, () => cdp.emit('Page.loadEventFired', {}));
    await waitForQuiet(cdp, 50, 5000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(105);
    expect(cdp.listenerCount('Page.loadEventFired')).toBe(0);
  });

  it('waitForQuiet gives up after maxMs on a page that keeps loading', async () => {
    const cdp = main();
    const tick = setInterval(() => cdp.emit('Page.loadEventFired', {}), 10);
    const t0 = Date.now();
    await waitForQuiet(cdp, 50, 120);
    clearInterval(tick);
    expect(Date.now() - t0).toBeLessThan(400);
  });
});
