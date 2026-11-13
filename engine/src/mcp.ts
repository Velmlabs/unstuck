import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createEngine, type EventLog, type Transport } from '@unstuck/core';
import { connectCdp } from './direct-cdp';
import { VERSION } from './version';

export const TOOL_NAME = 'request_human_takeover';

export interface McpServerOptions {
  transport: Transport;
  log?: EventLog;
  env: Record<string, string | undefined>;
  stderr: { write(s: string): unknown };
  /** Open the takeover link locally as soon as it exists (`--open`). */
  open?: boolean;
  openUrl?: (url: string) => void;
  connect?: typeof connectCdp;
}

/** Opens a URL with the desktop's default browser, detached. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // no desktop opener available; the link is still on stderr and in the MCP log
  }
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) });

/** MCP server exposing request_human_takeover (spec §5). */
export function createMcpServer(opts: McpServerOptions): McpServer {
  const server = new McpServer({ name: 'unstuck', version: VERSION }, { capabilities: { logging: {} } });
  const engine = createEngine({ transport: opts.transport, log: opts.log, requireCode: opts.env.UNSTUCK_REQUIRE_CODE === '1' });
  const connect = opts.connect ?? connectCdp;
  const openUrl = opts.openUrl ?? openInBrowser;

  server.registerTool(
    TOOL_NAME,
    {
      title: 'Request human takeover',
      description:
        'Ask a human to take over the live browser (CAPTCHA, login, 2FA, anything you are stuck on). ' +
        'Blocks until the human taps Done or Can\'t solve, or the takeover times out, then returns the outcome.',
      inputSchema: {
        reason: z.string().min(1).describe('What the human should do, e.g. "Solve the CAPTCHA"'),
        cdp_url: z.string().optional().describe('Browser DevTools endpoint (http://host:port, host:port or ws://…). Defaults to UNSTUCK_CDP_URL.'),
        target_id: z.string().optional().describe('CDP target id of the tab to take over. Defaults to the most recent page.'),
        timeout_s: z.number().int().min(10).max(3600).optional().describe('Seconds before the takeover gives up (default 600).'),
      },
    },
    async ({ reason, cdp_url, target_id, timeout_s }, extra) => {
      const url = cdp_url ?? opts.env.UNSTUCK_CDP_URL;
      if (!url) return text('No browser to take over: pass cdp_url or set UNSTUCK_CDP_URL', true);
      let cdp;
      try {
        cdp = await connect(url, { targetId: target_id });
      } catch (e) {
        return text((e as Error).message, true);
      }
      // The client gave up (notifications/cancelled): end the takeover so the link stops working.
      const onAbort = () => void cdp!.close();
      extra.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const site = await cdp
          .send<{ result: { value?: string } }>('Runtime.evaluate', { expression: 'location.hostname', returnByValue: true })
          .then((r) => r.result.value || undefined)
          .catch(() => undefined);
        const r = await engine.takeover(cdp, {
          reason,
          timeoutS: timeout_s,
          site,
          popups: cdp.popups,
          onLink: ({ url: link, code }) => {
            const line = `Unstuck: a human is needed (${reason}) → ${link}${code ? ` (code ${code})` : ''}`;
            opts.stderr.write(line + '\n');
            void server.sendLoggingMessage({ level: 'notice', logger: 'unstuck', data: line }).catch(() => {});
            if (opts.open) openUrl(link);
          },
        });
        const out = { status: r.status, session_id: r.sessionId, url: r.url, duration_s: r.durationS, ...(r.detail ? { detail: r.detail } : {}) };
        return text(JSON.stringify(out), r.status === 'failed');
      } finally {
        extra.signal.removeEventListener('abort', onAbort);
        await cdp.close();
      }
    },
  );

  const close = server.close.bind(server);
  server.close = async () => {
    await engine.close();
    await close();
  };
  return server;
}
