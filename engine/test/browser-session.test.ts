import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { FakeTransport } from '@velmlabs/unstuck-core/testing';
import { createEngine } from '@velmlabs/unstuck-core';
import { BrowserSession, type BrowserSessionDeps } from '../src/browser/session';
import { CHROME_NOT_FOUND, launchChrome } from '../src/browser/launcher';
import { nodeStoreFs } from '../src/browser/node-store-fs';
import { startChromium, type DebugChromium } from './chromium';

const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { executablePath(): string } };
let chrome: DebugChromium;
beforeAll(async () => {
  chrome = await startChromium();
}, 30_000);
afterAll(async () => {
  await chrome?.stop();
});

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-session-'));
const deps = (launch?: object) => ({
  engine: createEngine({ transport: new FakeTransport() }),
  storeFs: nodeStoreFs(),
  runTakeover: vi.fn<BrowserSessionDeps['runTakeover']>(async () => ({ status: 'resolved', sessionId: 's', url: 'u', durationS: 0 })),
  ...(launch ? { launch } : {}),
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('BrowserSession', { timeout: 30_000 }, () => {
  it('nothing is launched before the first call; tab() launches once for concurrent callers; close() stops what it launched', async () => {
    const launched: { pid: number }[] = [];
    const chromeLaunch = vi.fn(async (o: { path: string }) => {
      const b = await launchChrome({ path: o.path, isRoot: process.getuid?.() === 0 });
      launched.push(b);
      return b;
    });
    const s = new BrowserSession(
      { source: { kind: 'chrome' }, profile: 'mcp', remember: false, maxRescuesPerHour: 10, home: home() },
      deps({ chrome: chromeLaunch, findChrome: () => chromium.executablePath() }),
    );
    expect(chromeLaunch).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([s.tab(), s.tab()]);
    expect(a).toBe(b);
    expect(chromeLaunch).toHaveBeenCalledOnce();
    expect(s.holder).toBeNull();
    const ep = await s.endpoint();
    expect(ep.url).toMatch(/^ws:\/\//);
    expect(ep.targetId).toBe(a.cdp.targetId);
    expect(s.launched).toBe(true);
    await s.close();
    expect(alive(launched[0]!.pid)).toBe(false);
    await s.close(); // twice is fine
  }, 30_000);

  it('close() leaves a cdp browser running, and closes only its own tab', async () => {
    const s = new BrowserSession({ source: { kind: 'cdp', url: chrome.wsUrl }, profile: 'mcp', remember: false, maxRescuesPerHour: 10, home: home() }, deps());
    const { cdp } = await s.tab();
    const id = cdp.targetId;
    expect(s.launched).toBe(false);
    await s.close();
    const targets = (await fetch(`http://127.0.0.1:${chrome.port}/json/list`).then((r) => r.json())) as { id: string }[];
    expect(targets.some((t) => t.id === id)).toBe(false);
    expect(targets.length).toBeGreaterThan(0);
  });

  it('a missing Chrome reports CHROME_NOT_FOUND, and the next call tries again', async () => {
    let found = false;
    const s = new BrowserSession(
      { source: { kind: 'chrome' }, profile: 'mcp', remember: false, maxRescuesPerHour: 10, home: home() },
      deps({
        findChrome: () => {
          if (!found) throw new Error(CHROME_NOT_FOUND);
          return chromium.executablePath();
        },
      }),
    );
    await expect(s.tab()).rejects.toThrow(CHROME_NOT_FOUND);
    found = true;
    await expect(s.tab()).resolves.toHaveProperty('guard');
    await s.close();
  }, 30_000);

  it('obscura: launches the binary it was given', async () => {
    const obscura = vi.fn(async () => {
      throw new Error('obscura failed to start');
    });
    const s = new BrowserSession({ source: { kind: 'obscura', path: '/opt/obscura' }, profile: 'mcp', remember: false, maxRescuesPerHour: 10, home: home() }, deps({ obscura }));
    await expect(s.tab()).rejects.toThrow('obscura failed to start');
    expect(obscura).toHaveBeenCalledWith({ path: '/opt/obscura' });
  });

  it('the rescue runner sets holder while a takeover runs and tells onTakeoverStart listeners', async () => {
    const d = deps();
    let release!: () => void;
    d.runTakeover.mockImplementation(async (_cdp, _reason, onReady) => {
      onReady({ sessionId: 'sess-1', url: 'http://x/s/sess-1', reason: 'r', expiresAt: Date.now() + 1000 }, { joined: () => false, cancel: () => {}, fail: () => {} } as never);
      await new Promise<void>((r) => (release = r));
      return { status: 'resolved', sessionId: 'sess-1', url: 'u', durationS: 1 };
    });
    const s = new BrowserSession({ source: { kind: 'cdp', url: chrome.wsUrl }, profile: 'mcp', remember: false, maxRescuesPerHour: 10, home: home() }, d);
    const seen: string[] = [];
    const off = s.onTakeoverStart((info) => seen.push(info.sessionId));
    const { guard } = await s.tab();
    const asked = guard.askHuman('Log in');
    await vi.waitFor(() => expect(s.holder).toBe('sess-1'));
    expect(seen).toEqual(['sess-1']);
    release();
    await expect(asked).resolves.toMatchObject({ status: 'resolved' });
    expect(s.holder).toBeNull();
    off();
    await s.close();
  });

  it('a tab that closed under it (or a browser that went away) is replaced on the next call', async () => {
    const s = new BrowserSession({ source: { kind: 'cdp', url: chrome.wsUrl }, profile: 'mcp', remember: false, maxRescuesPerHour: 10, home: home() }, deps());
    const first = await s.tab();
    const id = first.cdp.targetId;
    await fetch(`http://127.0.0.1:${chrome.port}/json/close/${id}`);
    await vi.waitFor(() => expect(s.targetId).toBeNull(), { timeout: 5000 });
    const second = await s.tab();
    expect(second.cdp.targetId).not.toBe(id);
    await expect(second.guard.check()).resolves.toBeNull();
    await s.close();
  });
});

