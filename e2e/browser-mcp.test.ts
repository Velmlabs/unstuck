// Unstuck Browser's MCP server end to end: the engine binary with --mcp --browser starts its own headless Chromium on the
// first browsing call, reads pages, and hands a human check to a person and back. The test site is on 127.0.0.1, so
// these servers run with --allow-private-network; one test checks the default blocks it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { actAsHuman, chromium, ENGINE, REPO } from './examples/harness';
import { startChallengeSite, type ChallengeSite } from './browser/challenge-site';

const req = createRequire(`${REPO}/engine/package.json`);
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = req('@modelcontextprotocol/sdk/client/stdio.js');

let site: ChallengeSite;
beforeAll(async () => {
  site = await startChallengeSite();
});
afterAll(() => site?.close());

const profiles = () => new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('unstuck-chrome-')));

async function mcp(args: string[], env: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-e2e-home-'));
  const transport = new StdioClientTransport({
    command: ENGINE,
    args,
    env: { ...process.env, CHROME_PATH: chromium.executablePath(), UNSTUCK_HOME: home, ...env },
    stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (d: Buffer) => (err += d));
  const client = new Client({ name: 'e2e', version: '0' });
  await client.connect(transport);
  const call = (name: string, a: object = {}) => client.callTool({ name, arguments: a }, undefined, { timeout: 120_000 }) as Promise<any>;
  return { client, call, err: () => err, home, close: () => client.close() };
}

describe('Unstuck Browser over MCP', () => {
  it('tools/list starts no browser; the first fetch_page does; closing stdin stops it and removes its profile dir', async () => {
    const before = profiles();
    const m = await mcp(['--mcp', '--browser', '--allow-private-network']);
    const names = (await m.client.listTools()).tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['fetch_page', 'open', 'ask_human', 'resume_after_human', 'request_human_takeover']));
    expect([...profiles()].filter((d) => !before.has(d))).toEqual([]);
    const r = await m.call('fetch_page', { url: `${site.url}/article` });
    expect(r.isError).toBeFalsy();
    const started = [...profiles()].filter((d) => !before.has(d));
    expect(started).toHaveLength(1);
    await m.close();
    await expect.poll(() => fs.existsSync(path.join(os.tmpdir(), started[0]!)), { timeout: 10_000 }).toBe(false);
  });

  it('fetch_page round trip on /article returns markdown', async () => {
    const m = await mcp(['--mcp', '--browser', '--allow-private-network']);
    const r = await m.call('fetch_page', { url: `${site.url}/article` });
    expect(r.structuredContent).toMatchObject({ status: 200, final_url: `${site.url}/article` });
    expect(r.structuredContent.content).toMatch(/^# /);
    expect(r.structuredContent).not.toHaveProperty('session');
    await m.close();
  });

  it('fetch_page on /cf → human_needed → Done → resume_after_human returns the content', async () => {
    site.reset();
    const m = await mcp(['--mcp', '--browser', '--allow-private-network'], { UNSTUCK_IN_TOOL_WAIT_S: '3' });
    const h = await m.call('fetch_page', { url: `${site.url}/cf` });
    expect(h.structuredContent).toMatchObject({ status: 'human_needed', takeover_id: expect.any(String), link: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/s\//) });
    site.solve();
    const person = actAsHuman(h.structuredContent.link, 'done');
    let r = await m.call('resume_after_human', { takeover_id: h.structuredContent.takeover_id, max_wait_s: 60 });
    while (r.structuredContent?.status === 'waiting') r = await m.call('resume_after_human', { takeover_id: h.structuredContent.takeover_id, max_wait_s: 60 });
    await person;
    expect(r.structuredContent).toMatchObject({ rescued: true, title: 'Shop', status: 200 });
    expect(r.structuredContent.content).toContain('Welcome to the shop');
    expect(site.hits('/cf')).toBe(2);
    expect(fs.readFileSync(path.join(m.home, 'profiles', 'mcp', 'sites.json'), 'utf8')).toContain('cf_clearance');
    await m.close();
  });

  it('--tools takeover lists only the four tools', async () => {
    const m = await mcp(['--mcp', '--tools', 'takeover']);
    expect((await m.client.listTools()).tools.map((t: { name: string }) => t.name).sort()).toEqual(['cancel_human_takeover', 'request_human_takeover', 'start_human_takeover', 'wait_for_human_takeover']);
    await m.close();
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('%s to the MCP server stops the Chrome it started and removes its profile dir', async (sig) => {
    const before = profiles();
    const m = await mcp(['--mcp', '--browser', '--allow-private-network']);
    await m.call('fetch_page', { url: `${site.url}/article` });
    const started = [...profiles()].filter((d) => !before.has(d));
    expect(started).toHaveLength(1);
    const pid = (m.client as any)._transport._process.pid as number;
    process.kill(pid, sig);
    await expect.poll(() => fs.existsSync(path.join(os.tmpdir(), started[0]!)), { timeout: 10_000 }).toBe(false);
    await m.close().catch(() => {});
  });

  it('by default the browser refuses this machine: a 127.0.0.1 site is a tool error naming the flag', async () => {
    const m = await mcp(['--mcp', '--browser']);
    const r = await m.call('fetch_page', { url: `${site.url}/article` });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('127.0.0.1 is a private or local address');
    expect(r.content[0].text).toContain('--allow-private-network');
    await m.close();
  });
});

