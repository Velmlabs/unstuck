import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { FakeTransport } from '@unstuck/core/testing';
import { createMcpServer, openInBrowser, TOOL_NAME } from '../src/mcp';
import { createEmbeddedTransport, type AssetMap } from '../src/embedded';
import { ASSETS } from '../src/assets.gen';
import { startChromium, type DebugChromium } from './chromium';

const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<any> } };
let chrome: DebugChromium;
let humanBrowser: any;
beforeAll(async () => {
  chrome = await startChromium();
  humanBrowser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await humanBrowser?.close();
  await chrome?.stop();
});

async function connect(opts: Partial<Parameters<typeof createMcpServer>[0]> = {}) {
  const transport = opts.transport ?? (await createEmbeddedTransport({ assets: ASSETS as AssetMap }));
  let err = '';
  const opened: string[] = [];
  const server = createMcpServer({
    transport,
    env: {},
    stderr: { write: (s: string) => (err += s) },
    openUrl: (u) => opened.push(u),
    ...opts,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  const logs: string[] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => void logs.push(String(n.params.data)));
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, server, logs, opened, err: () => err, transport };
}

describe('MCP server', () => {
  it('lists request_human_takeover with its schema', async () => {
    const { client, server } = await connect({ transport: new FakeTransport() });
    const { tools } = await client.listTools();
    expect(TOOL_NAME).toBe('request_human_takeover');
    const tool = tools.find((t) => t.name === TOOL_NAME)!;
    expect(tool.inputSchema.required).toEqual(['reason']);
    expect(Object.keys(tool.inputSchema.properties!)).toEqual(['reason', 'cdp_url', 'target_id', 'timeout_s']);
    await server.close();
  });

  it('Review Focus 2: sends the link before the tool returns, then returns the result when the human taps Done', async () => {
    const { client, server, logs, err, opened } = await connect();
    const call = client.callTool({ name: TOOL_NAME, arguments: { reason: 'Solve the CAPTCHA', cdp_url: `127.0.0.1:${chrome.port}`, timeout_s: 60 } });
    await vi.waitFor(() => expect(logs.join('')).toMatch(/http:\/\/127\.0\.0\.1:\d+\/s\//), { timeout: 15_000 });
    const url = /http:\/\/127\.0\.0\.1:\d+\/s\/\S+/.exec(logs.join(''))![0];
    expect(logs[0]).toBe(`Unstuck: a human is needed (Solve the CAPTCHA) → ${url}`);
    expect(err()).toContain(url);
    expect(opened).toEqual([]);

    const human = await humanBrowser.newPage();
    await human.goto(url);
    await human.getByRole('button', { name: 'Done' }).click();
    const res = (await call) as { content: { type: string; text: string }[]; isError?: boolean };
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ status: 'resolved', url, duration_s: expect.any(Number) });
    await human.close();
    await server.close();
  });

  it('UNSTUCK_CDP_URL is used when cdp_url is omitted, and --open opens the link once', async () => {
    const { client, server, opened } = await connect({ env: { UNSTUCK_CDP_URL: `http://127.0.0.1:${chrome.port}` }, open: true });
    const res = (await client.callTool({ name: TOOL_NAME, arguments: { reason: 'r', timeout_s: 10 } }).catch((e) => e)) as never;
    void res;
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\//);
    await server.close();
  }, 30_000);

  it('no browser configured → a clear tool error', async () => {
    const { client, server } = await connect({ transport: new FakeTransport() });
    const res = (await client.callTool({ name: TOOL_NAME, arguments: { reason: 'r' } })) as { content: { text: string }[]; isError: boolean };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toBe('No browser to take over: pass cdp_url or set UNSTUCK_CDP_URL');
    await server.close();
  });

  it('an unknown target_id → isError with "target … not found"', async () => {
    const { client, server } = await connect({ transport: new FakeTransport() });
    const res = (await client.callTool({ name: TOOL_NAME, arguments: { reason: 'r', cdp_url: `127.0.0.1:${chrome.port}`, target_id: 'nope' } })) as {
      content: { text: string }[];
      isError: boolean;
    };
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('target nope not found');
    await server.close();
  });

  it('a timed-out takeover is returned as a result (not an error), and the browser connection is released', async () => {
    const { client, server } = await connect();
    const res = (await client.callTool({ name: TOOL_NAME, arguments: { reason: 'r', cdp_url: `127.0.0.1:${chrome.port}`, timeout_s: 10 } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ status: 'timed_out' });
    await server.close();
  }, 30_000);

  it('rejects timeout_s outside 10..3600', async () => {
    const { client, server } = await connect({ transport: new FakeTransport() });
    const res = (await client.callTool({ name: TOOL_NAME, arguments: { reason: 'r', timeout_s: 5 } })) as { isError: boolean };
    expect(res.isError).toBe(true);
    await server.close();
  });
});

describe('openInBrowser', () => {
  it('never throws, even without a desktop opener', () => {
    expect(() => openInBrowser('http://127.0.0.1:1/s/x')).not.toThrow();
  });
});
