import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeTransport } from '@velmlabs/unstuck-core/testing';
import { createMcpServer, TOOL_NAMES, WAIT_TOOL, START_TOOL } from '../src/mcp';
import { BROWSE_TOOL_NAMES } from '../src/mcp-browse';
import { CHROME_NOT_FOUND } from '../src/browser/launcher';
import { startChromium, type DebugChromium } from './chromium';

const INTERSTITIAL = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../core/test/fixtures/human-checks/cloudflare-interstitial.html'), 'utf8');
const ARTICLE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'extract', 'article.html'), 'utf8');
// The challenge reloads itself once the person has solved it (as Cloudflare's does).
const CHALLENGE = INTERSTITIAL.replace('</body>', "<script>setInterval(() => fetch('/cf-status').then((r) => r.text()).then((t) => t === 'ok' && location.reload()), 150);</script></body>");

let chrome: DebugChromium;
let server: http.Server;
let site = '';
let solved = false;
const hits = new Map<string, number>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = (req.url ?? '').split('?')[0]!;
    hits.set(p, (hits.get(p) ?? 0) + 1);
    if (p === '/article') return void res.writeHead(200, { 'content-type': 'text/html' }).end(ARTICLE);
    if (p === '/doc.pdf') return void res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4\n%%EOF\n');
    if (p === '/data.json') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    if (p === '/cf-status') return void res.writeHead(200, { 'content-type': 'text/plain' }).end(solved ? 'ok' : 'no');
    if (p === '/cf') {
      // Only `solved` counts: the shared test browser keeps the cookie from earlier tests.
      if (solved) return void res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'cf_clearance=ok; Path=/' }).end('<!doctype html><title>Shop</title><h1>Shop</h1><p>Welcome to the shop.</p>');
      return void res.writeHead(403, { 'content-type': 'text/html' }).end(CHALLENGE);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  chrome = await startChromium();
}, 30_000);
afterAll(async () => {
  await chrome?.stop();
  await new Promise((r) => server.close(r));
});

type Res = { isError?: boolean; structuredContent?: any; content: { type: string; text: string }[] };
let home: string;
beforeEach(() => {
  solved = false;
  hits.clear();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-browse-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

async function open(o: { browse?: boolean; remember?: boolean; inToolWaitMs?: number; env?: Record<string, string>; noChrome?: boolean } = {}) {
  const transport = new FakeTransport();
  let err = '';
  const srv = createMcpServer({
    transport,
    env: o.env ?? {},
    ...(o.noChrome
      ? {
          launch: {
            findChrome: () => {
              throw new Error(CHROME_NOT_FOUND);
            },
          },
        }
      : {}),
    stderr: { write: (s: string) => (err += s) },
    ...(o.browse === false
      ? {}
      : { browse: { source: o.noChrome ? { kind: 'chrome' } : { kind: 'cdp', url: chrome.wsUrl }, profile: 'mcp', remember: o.remember ?? false, maxRescuesPerHour: 10, home, inToolWaitMs: o.inToolWaitMs ?? 1500 } }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await srv.connect(serverSide);
  await client.connect(clientSide);
  const call = (name: string, args: object = {}) => client.callTool({ name, arguments: args as Record<string, unknown> }) as Promise<Res>;
  /** The person: waits for the link on stderr, solves the check, and presses Done. */
  const person = (o2: { solveAfterMs?: number } = {}) =>
    (async () => {
      await vi.waitFor(() => expect(err).toMatch(/→ (\S+)/), { timeout: 10_000 });
      const link = /→ (\S+)/.exec(err)![1]!;
      const v = transport.connect(link);
      v.push({ t: 'hello', token: new URLSearchParams(new URL(link).hash.slice(1)).get('t')! });
      await new Promise((r) => setTimeout(r, o2.solveAfterMs ?? 50));
      solved = true;
      await new Promise((r) => setTimeout(r, 400)); // the page reloads itself
      v.push({ t: 'done' });
    })();
  return { client, srv, call, person, err: () => err, transport, close: () => srv.close() };
}

describe('MCP browse tools', { timeout: 30_000 }, () => {
  it('without browse options the server lists exactly the four takeover tools', async () => {
    const m = await open({ browse: false });
    expect((await m.client.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    await m.close();
  });

  it('with browse options it adds fetch_page, get_session, forget_site, remember_site and resume_after_human', async () => {
    const m = await open();
    const tools = (await m.client.listTools()).tools;
    expect(BROWSE_TOOL_NAMES).toEqual(['fetch_page', 'get_session', 'forget_site', 'remember_site', 'resume_after_human']);
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES, ...BROWSE_TOOL_NAMES].sort());
    const fetchPage = tools.find((t) => t.name === 'fetch_page')!;
    expect(fetchPage.description).toMatch(/a person solves/i);
    expect(fetchPage.description).toMatch(/terms/);
    await m.close();
  });

  it('fetch_page returns markdown and no session unless asked', async () => {
    const m = await open();
    const r = await m.call('fetch_page', { url: `${site}/article` });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ final_url: `${site}/article`, status: 200, title: 'Shipping times', content: expect.stringContaining('# Shipping times') });
    expect(r.structuredContent).not.toHaveProperty('session');
    expect(r.structuredContent).not.toHaveProperty('truncated');
    const t = await m.call('fetch_page', { url: `${site}/data.json`, format: 'text' });
    expect(t.structuredContent.content).toBe('{"ok":true}');
    await m.close();
  });

  it('include_session returns cookies, the header and the user agent', async () => {
    const m = await open();
    solved = true;
    const r = await m.call('fetch_page', { url: `${site}/cf`, include_session: true });
    expect(r.structuredContent.session).toMatchObject({ site: '127.0.0.1', cookie_header: 'cf_clearance=ok', user_agent: expect.stringContaining('Mozilla') });
    expect(r.structuredContent.session.cookies[0]).toMatchObject({ name: 'cf_clearance', value: 'ok' });
    const s = await m.call('get_session', { domain: '127.0.0.1' });
    expect(s.structuredContent).toMatchObject({ site: '127.0.0.1', cookie_header: 'cf_clearance=ok' });
    await m.close();
  });

  it('refuses file:, chrome: and javascript: URLs', async () => {
    const m = await open();
    for (const url of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'not a url']) {
      const r = await m.call('fetch_page', { url });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe('fetch_page opens http and https URLs only');
    }
    await m.close();
  });

  it('a short rescue returns the page with rescued: true', async () => {
    const m = await open({ inToolWaitMs: 8000 });
    const person = m.person();
    const r = await m.call('fetch_page', { url: `${site}/cf` });
    await person;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ rescued: true, title: 'Shop', status: 200, waited_s: expect.any(Number) });
    await m.close();
  });

  it('a long rescue returns human_needed, other tools get human_takeover_active, resume_after_human returns the content without navigating again', async () => {
    const m = await open({ inToolWaitMs: 300 });
    const h = await m.call('fetch_page', { url: `${site}/cf` });
    expect(h.structuredContent).toMatchObject({ status: 'human_needed', takeover_id: expect.any(String), link: expect.any(String), expires_in_s: expect.any(Number), reason: expect.stringContaining('verify') });
    const id = h.structuredContent.takeover_id;
    expect(h.content[0]!.text).toContain(`Then call resume_after_human with takeover_id "${id}"; while it answers "waiting", call it again.`);
    expect((await m.call('fetch_page', { url: `${site}/article` })).structuredContent).toEqual({ error: 'human_takeover_active', takeover_id: id });
    expect((await m.call('get_session', { domain: '127.0.0.1' })).structuredContent).toEqual({ error: 'human_takeover_active', takeover_id: id });
    expect((await m.call('resume_after_human', { takeover_id: id, max_wait_s: 1 })).structuredContent).toMatchObject({ status: 'waiting', takeover_id: id, joined: false });
    const person = m.person();
    const r = await m.call('resume_after_human', { takeover_id: id });
    await person;
    expect(r.structuredContent).toMatchObject({ rescued: true, title: 'Shop' });
    expect(hits.get('/cf')).toBe(2); // the first load and the challenge page's own reload; never a third navigation by Unstuck
    expect((await m.call('resume_after_human', { takeover_id: id })).structuredContent).toMatchObject({ rescued: true, title: 'Shop' });
    await m.close();
  });

  it('wait_for_human_takeover on a browse rescue id returns the takeover result; resume_after_human refuses a start_human_takeover id', async () => {
    const m = await open({ inToolWaitMs: 300 });
    const h = await m.call('fetch_page', { url: `${site}/cf` });
    const id = h.structuredContent.takeover_id;
    const person = m.person();
    const w = await m.call(WAIT_TOOL, { takeover_id: id });
    await person;
    expect(w.structuredContent).toMatchObject({ status: 'resolved', session_id: id });
    expect((await m.call('resume_after_human', { takeover_id: 'nope' })).content[0]!.text).toMatch(/No takeover with takeover_id "nope"/);
    // start_human_takeover without cdp_url targets the browsing tab.
    const s = await m.call(START_TOOL, { reason: 'Log in please' });
    expect(s.structuredContent).toMatchObject({ takeover_id: expect.any(String) });
    const r = await m.call('resume_after_human', { takeover_id: s.structuredContent.takeover_id });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(`takeover_id "${s.structuredContent.takeover_id}" was started with start_human_takeover; use wait_for_human_takeover`);
    await m.call('cancel_human_takeover', { takeover_id: s.structuredContent.takeover_id });
    await m.close();
  });

  it('a failed rescue returns its status, detail and check as an error', async () => {
    const m = await open({ inToolWaitMs: 8000 });
    const person = (async () => {
      await vi.waitFor(() => expect(m.err()).toMatch(/→ (\S+)/), { timeout: 10_000 });
      const link = /→ (\S+)/.exec(m.err())![1]!;
      const v = m.transport.connect(link);
      v.push({ t: 'hello', token: new URLSearchParams(new URL(link).hash.slice(1)).get('t')! });
      v.push({ t: 'done' }); // without solving it
    })();
    const r = await m.call('fetch_page', { url: `${site}/cf` });
    await person;
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ status: 'still_blocked', check: { kind: 'challenge', vendor: 'cloudflare', site: '127.0.0.1' } });
    await m.close();
  });

  it('remember on: a resolved rescue is saved under profiles/mcp and forget_site removes it', async () => {
    const m = await open({ remember: true, inToolWaitMs: 8000 });
    const person = m.person();
    await m.call('fetch_page', { url: `${site}/cf` });
    await person;
    const file = path.join(home, 'profiles', 'mcp', 'sites.json');
    expect(fs.readFileSync(file, 'utf8')).toContain('cf_clearance');
    expect((await m.call('remember_site', { domain: '127.0.0.1' })).structuredContent).toEqual({ remembered: '127.0.0.1', cookies: 1 });
    expect((await m.call('forget_site', { domain: '127.0.0.1' })).structuredContent).toEqual({ forgotten: '127.0.0.1' });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('cf_clearance');
    await m.close();
  });

  it('a navigation error is the tool error', async () => {
    const m = await open();
    const r = await m.call('fetch_page', { url: 'http://127.0.0.1:1/' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^could not open http:\/\/127\.0\.0\.1:1\/: net::ERR_/);
    await m.close();
  });

  it("a missing Chrome is the tool's error text, for every browsing tool", async () => {
    const m = await open({ noChrome: true });
    for (const [name, args] of [['fetch_page', { url: `${site}/article` }], ['get_session', { domain: 'x.example' }]] as const) {
      const r = await m.call(name, args);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe(CHROME_NOT_FOUND);
    }
    await m.close();
  });

  it('a PDF is the tool error naming get_session and curl', async () => {
    const m = await open();
    const r = await m.call('fetch_page', { url: `${site}/doc.pdf` });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/is a application\/pdf file\. Use get_session and curl to download it\./);
    await m.close();
  });

  it('human_needed carries the 6-digit code; a cancelled rescue resumes as its failed outcome', async () => {
    const m = await open({ inToolWaitMs: 300, env: { UNSTUCK_REQUIRE_CODE: '1' } });
    const h = await m.call('fetch_page', { url: `${site}/cf` });
    expect(h.structuredContent).toMatchObject({ status: 'human_needed', code: expect.stringMatching(/^\d{6}$/) });
    expect(h.content[0]!.text).toContain(h.structuredContent.code);
    const id = h.structuredContent.takeover_id;
    const joiner = m.transport.connect(h.structuredContent.link);
    joiner.push({ t: 'hello', token: new URLSearchParams(new URL(h.structuredContent.link).hash.slice(1)).get('t')!, code: h.structuredContent.code });
    await vi.waitFor(async () => expect((await m.call('resume_after_human', { takeover_id: id, max_wait_s: 1 })).structuredContent).toMatchObject({ status: 'waiting', joined: true }), { timeout: 10_000 });
    await m.call('cancel_human_takeover', { takeover_id: id });
    const r = await m.call('resume_after_human', { takeover_id: id });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ status: 'cancelled', check: { vendor: 'cloudflare' } });
    await m.close();
  });
});
