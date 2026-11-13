import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import { actAsHuman, chromium, ENGINE, example, REPO, startSite } from './harness';

// The MCP client SDK comes from the engine's own dependencies (the engine is the MCP server).
const req = createRequire(`${REPO}/engine/package.json`);
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = req('@modelcontextprotocol/sdk/client/stdio.js');

const freePort = () =>
  new Promise<number>((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => r(port));
    });
  });
const readJson = (name: string) => JSON.parse(fs.readFileSync(example(`mcp/${name}`), 'utf8'));
const UNSTUCK = { command: 'npx', args: ['-y', '@velmlabs/unstuck-engine', '--mcp', '--open'], env: { UNSTUCK_CDP_URL: 'http://127.0.0.1:9222' } };

let site: Awaited<ReturnType<typeof startSite>>;
beforeAll(async () => (site = await startSite()));
afterAll(() => site?.close());

describe('MCP example', () => {
  it('mcp: an MCP client calls request_human_takeover; Done → resolved', async () => {
    const port = await freePort();
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(site.url + 'captcha');
    // As in claude-desktop.json, except the command: npx can't fetch the package before it's published.
    const cfg = readJson('claude-desktop.json').mcpServers.unstuck;
    const args = cfg.args.slice(2).filter((a: string) => a !== '--open');
    const transport = new StdioClientTransport({ command: ENGINE, args, env: { ...process.env, ...cfg.env, UNSTUCK_CDP_URL: `http://127.0.0.1:${port}` }, stderr: 'pipe' });
    let err = '';
    const link = new Promise<string>((resolve) =>
      transport.stderr!.on('data', (d: Buffer) => {
        err += d.toString();
        const m = /→ (\S+)/.exec(err);
        if (m) resolve(m[1]!);
      }),
    );
    const client = new Client({ name: 'example-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      expect((await client.listTools()).tools.map((t: { name: string }) => t.name)).toContain('request_human_takeover');
      const call = client.callTool({ name: 'request_human_takeover', arguments: { reason: 'Solve the CAPTCHA', timeout_s: 120 } }, undefined, { timeout: 150_000 });
      await actAsHuman(await link, 'done');
      const result = await call;
      expect(JSON.parse(result.content[0].text).status).toBe('resolved');
    } finally {
      await client.close();
      await browser.close();
    }
  });

  it('mcp: config files are valid and consistent', () => {
    expect(readJson('claude-desktop.json').mcpServers.unstuck).toEqual(UNSTUCK);
    expect(readJson('cursor.json').mcpServers.unstuck).toEqual(UNSTUCK);
    const both = readJson('playwright-mcp.json').mcpServers;
    expect(both.unstuck).toEqual(UNSTUCK);
    expect(both.playwright.args).toContain('@playwright/mcp@0.0.85'); // pinned, like every third-party version in the examples
    expect(both.playwright.args).toContain('--cdp-endpoint');
    expect(both.playwright.args).toContain('http://127.0.0.1:9222');
    const sh = fs.readFileSync(example('mcp/claude-code.sh'), 'utf8');
    expect(sh).toContain('claude mcp add unstuck');
    expect(sh).toContain('UNSTUCK_CDP_URL=http://127.0.0.1:9222');
    expect(sh).toContain('npx -y @velmlabs/unstuck-engine --mcp');
  });
});
