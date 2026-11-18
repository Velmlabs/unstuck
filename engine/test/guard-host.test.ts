import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createRpcPeer, Methods, type RpcPeer } from '@velmlabs/unstuck-protocol';
import { FakeCdp, FakeTransport } from '@velmlabs/unstuck-core/testing';
import { createEngine, type LinkInfo } from '@velmlabs/unstuck-core';
import { registerGuardMethods } from '../src/guard-host';
import { nodeStoreFs } from '../src/browser/node-store-fs';

const CF_MARKER = '#challenge-form, #challenge-stage, #cf-challenge-running, script[src*="/cdn-cgi/challenge-platform/"]';
const facts = (o: object = {}) => ({
  url: 'https://shop.example/',
  title: 'Shop',
  iframes: [],
  markers: [],
  tokenFields: {},
  passwordVisible: false,
  otpVisible: false,
  headings: [],
  bodyTextLength: 500,
  bodyTextHead: 'Welcome',
  ...o,
});
const cloudflare = () => facts({ title: 'Just a moment...', markers: [CF_MARKER] });

function greenPng(): string {
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([0, 255, 0, 255], i);
  return PNG.sync.write(png).toString('base64');
}

/** An SDK peer linked to an engine-side peer, with page p1 showing `state.facts`, and a probe tab for page.create. */
function harness(home: string) {
  let engineSide!: RpcPeer;
  const sdk = createRpcPeer((l) => queueMicrotask(() => engineSide.receive(l)));
  engineSide = createRpcPeer((l) => queueMicrotask(() => sdk.receive(l)));
  const state = { facts: cloudflare() as object };
  const page = new FakeCdp();
  page.respond('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'MAIN' } } }));
  page.respond('Runtime.evaluate', (p) => {
    const e = (p as { expression: string }).expression;
    if (e === 'navigator.userAgent') return { result: { value: 'UA/1' } };
    if (e === 'location.href') return { result: { value: (state.facts as { url: string }).url } };
    return { result: { value: state.facts } };
  });
  page.respond('Storage.getCookies', () => ({
    cookies: [{ name: 'cf_clearance', value: 'ok', domain: '.shop.example', path: '/', expires: -1, httpOnly: true, secure: true, size: 10, session: true }],
  }));
  const probe = new FakeCdp();
  probe.respond('Runtime.evaluate', (p) => {
    const e = (p as { expression: string }).expression;
    if (e.includes('__childLoaded')) return { result: { value: true } };
    return { result: { value: { x: 1, y: 1, dpr: 1 } } };
  });
  probe.respond('Page.captureScreenshot', () => ({ data: greenPng() }));
  const pages: Record<string, FakeCdp> = { p1: page, probe1: probe };
  sdk.handle(Methods.cdpSend, (raw) => {
    const p = raw as { pageId: string; method: string; params?: object };
    return pages[p.pageId]!.send(p.method, p.params);
  });
  sdk.handle(Methods.cdpSubscribe, () => ({}));
  const created: string[] = [];
  const closed: string[] = [];
  sdk.handle(Methods.pageCreate, (raw) => {
    created.push((raw as { pageId: string }).pageId);
    return { pageId: 'probe1' };
  });
  sdk.handle(Methods.pageClose, (raw) => {
    closed.push((raw as { pageId: string }).pageId);
    return {};
  });
  const rescueNotes: unknown[] = [];
  sdk.onNotification(Methods.guardRescue, (p) => rescueNotes.push(p));

  const transport = new FakeTransport();
  const engine = createEngine({ transport });
  const links: LinkInfo[] = [];
  // The person: opens each link, solves the check (the page turns clean) and presses Done.
  const linkFor = vi.fn((_pageId: string, _site: string | undefined, _alerts: unknown) => (info: LinkInfo) => {
    links.push(info);
    void (async () => {
      const viewer = transport.connect(info.url);
      viewer.push({ t: 'hello', token: new URLSearchParams(new URL(info.url).hash.slice(1)).get('t') });
      await new Promise((r) => setTimeout(r, 30));
      state.facts = facts();
      viewer.push({ t: 'done' });
    })();
  });
  const host = registerGuardMethods({
    peer: engineSide,
    engine,
    env: { UNSTUCK_HOME: home },
    storeFs: nodeStoreFs(),
    popupsFor: () => ({ onPopup: () => () => {} }),
    linkFor,
  });
  return { sdk, state, page, created, closed, rescueNotes, links, linkFor, host, engine };
}

describe('registerGuardMethods', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'unstuck-guard-host-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('guard.after on a challenge runs a takeover, sends the link and guard.rescue active true then false, and returns resolved', async () => {
    const h = harness(home);
    const { guardId } = await h.sdk.request<{ guardId: string }>(Methods.guardOpen, { pageId: 'p1', browserKey: 'b1' });
    const out = await h.sdk.request(Methods.guardAfter, { guardId, requestedUrl: 'https://shop.example/' });
    expect(out).toMatchObject({ status: 'resolved', check: { vendor: 'cloudflare' } });
    expect(h.rescueNotes).toEqual([
      { guardId, pageId: 'p1', active: true },
      { guardId, pageId: 'p1', active: false },
    ]);
    expect(h.links).toHaveLength(1);
    expect(h.linkFor).toHaveBeenCalledWith('p1', 'shop.example', undefined);
    await h.host.closeAll();
    await h.engine.close();
  });

  it('guard approval rescue passes mode, kind and timeoutS (approvalTimeoutS), and the control rescue its kind', async () => {
    const h = harness(home);
    const calls: any[] = [];
    const real = h.engine.takeover.bind(h.engine);
    h.engine.takeover = (cdp, o) => (calls.push(o), real(cdp, o));
    h.state.facts = facts({ url: 'https://bank.example/approve', bodyTextHead: 'Approve this sign-in on your phone. Open the app and tap yes' });
    const { guardId } = await h.sdk.request<{ guardId: string }>(Methods.guardOpen, { pageId: 'p1', browserKey: 'b1', approvalTimeoutS: 77, timeoutS: 500, rescue: ['approval'] });
    await h.sdk.request(Methods.guardAfter, { guardId, requestedUrl: 'https://bank.example/approve' }).catch(() => {});
    expect(calls[0]).toMatchObject({ mode: 'approval', kind: 'approval', timeoutS: 77 });
    h.state.facts = cloudflare();
    const g2 = await h.sdk.request<{ guardId: string }>(Methods.guardOpen, { pageId: 'p1', browserKey: 'b1', timeoutS: 500 });
    await h.sdk.request(Methods.guardAfter, { guardId: g2.guardId });
    expect(calls[1]).toMatchObject({ kind: 'challenge', timeoutS: 500 });
    expect(calls[1].mode).not.toBe('approval');
    await h.host.closeAll();
    await h.engine.close();
  });

  it('guard.after with nothing detected returns null and opens no takeover', async () => {
    const h = harness(home);
    h.state.facts = facts();
    const { guardId } = await h.sdk.request<{ guardId: string }>(Methods.guardOpen, { pageId: 'p1', browserKey: 'b1' });
    await expect(h.sdk.request(Methods.guardAfter, { guardId })).resolves.toBeNull();
    await expect(h.sdk.request(Methods.guardBefore, { guardId })).resolves.toBeNull();
    await expect(h.sdk.request(Methods.guardCheck, { guardId })).resolves.toBeNull();
    expect(h.links).toHaveLength(0);
    expect(h.rescueNotes).toEqual([]);
    await h.host.closeAll();
  });

  it('remember: true writes sites.json with mode 0600 under UNSTUCK_HOME/profiles/default', async () => {
    const h = harness(home);
    const { guardId } = await h.sdk.request<{ guardId: string }>(Methods.guardOpen, { pageId: 'p1', browserKey: 'b1', remember: true });
    await expect(h.sdk.request(Methods.guardAfter, { guardId })).resolves.toMatchObject({ status: 'resolved' });
    const file = join(home, 'profiles', 'default', 'sites.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toContain('cf_clearance');
    await expect(h.sdk.request(Methods.guardSession, { guardId, domain: 'shop.example' })).resolves.toMatchObject({ site: 'shop.example', userAgent: 'UA/1' });
    await expect(h.sdk.request(Methods.guardRemember, { guardId, domain: 'shop.example' })).resolves.toEqual({});
    await expect(h.sdk.request(Methods.guardForget, { guardId, domain: 'shop.example' })).resolves.toEqual({});
    await expect(h.sdk.request(Methods.guardForgetAll, { guardId })).resolves.toEqual({});
    expect(await readFile(file, 'utf8')).not.toContain('cf_clearance');
    await expect(h.sdk.request(Methods.guardClose, { guardId })).resolves.toEqual({});
    await h.engine.close();
  });

  it('maxRescuesPerHour: 1 → the second check is rescue_limited', async () => {
    const h = harness(home);
    const { guardId } = await h.sdk.request<{ guardId: string }>(Methods.guardOpen, { pageId: 'p1', browserKey: 'b1', maxRescuesPerHour: 1 });
    await expect(h.sdk.request(Methods.guardAfter, { guardId })).resolves.toMatchObject({ status: 'resolved' });
    h.state.facts = cloudflare();
    await expect(h.sdk.request(Methods.guardAfter, { guardId })).resolves.toMatchObject({ status: 'rescue_limited' });
    await expect(h.sdk.request(Methods.guardAskHuman, { guardId, reason: 'log in please' })).resolves.toMatchObject({ status: 'rescue_limited', check: { kind: 'ask' } });
    expect(h.links).toHaveLength(1);
    await h.host.closeAll();
    await h.engine.close();
  });

  it('browser.paintCheck probes once per browserKey through page.create and page.close', async () => {
    const h = harness(home);
    await expect(h.sdk.request(Methods.paintCheck, { pageId: 'p1', browserKey: 'b1' })).resolves.toEqual({ paint: true });
    await expect(h.sdk.request(Methods.paintCheck, { pageId: 'p1', browserKey: 'b1' })).resolves.toEqual({ paint: true });
    expect(h.created).toEqual(['p1']);
    expect(h.closed).toEqual(['probe1']);
    // A guard on the same browser reuses the answer: the challenge rescue doesn't probe again.
    const { guardId } = await h.sdk.request<{ guardId: string }>(Methods.guardOpen, { pageId: 'p1', browserKey: 'b1' });
    await expect(h.sdk.request(Methods.guardAfter, { guardId })).resolves.toMatchObject({ status: 'resolved' });
    expect(h.created).toEqual(['p1']);
    await h.host.closeAll();
    await h.engine.close();
  });

  it('an unknown guardId is an error with code unknown_guard', async () => {
    const h = harness(home);
    await expect(h.sdk.request(Methods.guardAfter, { guardId: 'nope' })).rejects.toMatchObject({ code: 'unknown_guard' });
    const { guardId } = await h.sdk.request<{ guardId: string }>(Methods.guardOpen, { pageId: 'p1', browserKey: 'b1' });
    await h.sdk.request(Methods.guardClose, { guardId });
    await expect(h.sdk.request(Methods.guardCheck, { guardId })).rejects.toMatchObject({ code: 'unknown_guard' });
  });

  it('a bad profile name is a config_error', async () => {
    const h = harness(home);
    await expect(h.sdk.request(Methods.guardOpen, { pageId: 'p1', browserKey: 'b1', profile: '../x' })).rejects.toMatchObject({ code: 'config_error' });
  });

  it("alerts: 'required' without Unstuck Cloud is a config_error; remember and forget need a domain", async () => {
    const h = harness(home);
    await expect(h.sdk.request(Methods.guardOpen, { pageId: 'p1', browserKey: 'b1', alerts: 'required' })).rejects.toMatchObject({ code: 'config_error' });
    const { guardId } = await h.sdk.request<{ guardId: string }>(Methods.guardOpen, { pageId: 'p1', browserKey: 'b1' });
    await expect(h.sdk.request(Methods.guardRemember, { guardId })).rejects.toMatchObject({ code: 'bad_params' });
    await expect(h.sdk.request(Methods.guardForget, { guardId })).rejects.toMatchObject({ code: 'bad_params' });
    await h.host.closeAll();
  });

  it('a probe tab that fails to navigate is closed, and the answer is unknown (asked again next time)', async () => {
    const h = harness(home);
    // page.create answers probe1; make its navigation fail.
    const probe = new FakeCdp();
    probe.respond('Page.navigate', () => {
      throw new Error('net::ERR_ABORTED');
    });
    h.sdk.handle(Methods.cdpSend, (raw) => {
      const p = raw as { pageId: string; method: string; params?: object };
      return (p.pageId === 'probe1' ? probe : h.page).send(p.method, p.params);
    });
    await expect(h.sdk.request(Methods.paintCheck, { pageId: 'p1', browserKey: 'b2' })).resolves.toEqual({ paint: 'unknown' });
    await expect(h.sdk.request(Methods.paintCheck, { pageId: 'p1', browserKey: 'b2' })).resolves.toEqual({ paint: 'unknown' });
    expect(h.created).toHaveLength(2);
    expect(h.closed).toEqual(['probe1', 'probe1']);
  });
});
