// examples/mcp: every client config parses, runs the published Unstuck MCP server against the shared Chrome, and
// pins the browser MCP server it pairs with. The README and the docs include these files, so they must stay right.
import { readFileSync, readdirSync } from 'node:fs';
import { extname } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { describe, it, expect } from 'vitest';

const dir = new URL('../examples/mcp/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const files = readdirSync(dir).filter((f) => f !== 'README.md').sort();
const CDP = 'http://127.0.0.1:9222';
const ENGINE = ['-y', '@velmlabs/unstuck-engine', '--mcp', '--open'];

/** Parses a config file by its extension. */
const parse = (name) => ({ '.json': JSON.parse, '.toml': parseToml, '.yaml': parseYaml })[extname(name)](read(name));

/** The servers a config defines, each as { command: [...argv], env }, whatever the client's format. */
function servers(name) {
  const c = parse(name);
  if (c.extensions) return Object.fromEntries(Object.entries(c.extensions).map(([k, s]) => [k, { argv: [s.cmd, ...s.args], env: s.envs ?? {} }])); // goose
  if (c.mcp_servers) return Object.fromEntries(Object.entries(c.mcp_servers).map(([k, s]) => [k, { argv: [s.command, ...s.args], env: s.env ?? {} }])); // codex
  if (c.mcp) return Object.fromEntries(Object.entries(c.mcp.servers).map(([k, s]) => [k, { argv: s.command, env: s.environment ?? {} }])); // opencode
  return Object.fromEntries(Object.entries(c.mcpServers).map(([k, s]) => [k, { argv: [s.command, ...s.args], env: s.env ?? {} }]));
}

describe('examples/mcp', () => {
  it('has a config for each documented client', () => {
    expect(files).toEqual(
      expect.arrayContaining(['claude-code.sh', 'claude-desktop.json', 'codex.toml', 'copilot-mcp-config.json', 'cursor.json', 'gemini-settings.json', 'antigravity-mcp-config.json', 'goose.yaml', 'opencode.json', 'pi-mcp.json', 'playwright-mcp.json']),
    );
  });

  it.each(files)('%s references the published engine in MCP mode', (name) => {
    const text = read(name);
    expect(text).toContain('@velmlabs/unstuck-engine');
    expect(text).toContain('--mcp');
  });

  it.each(files.filter((f) => f !== 'claude-code.sh'))('%s parses and runs Unstuck against the shared Chrome', (name) => {
    const all = servers(name);
    expect(all.unstuck.argv).toEqual(['npx', ...ENGINE]);
    expect(all.unstuck.env).toEqual({ UNSTUCK_CDP_URL: CDP });
    for (const [key, s] of Object.entries(all).filter(([k]) => k !== 'unstuck')) {
      expect(key).toBe('playwright');
      expect(s.argv).toEqual(['npx', '-y', '@playwright/mcp@0.0.85', '--cdp-endpoint', CDP]); // pinned, like every third-party version in the examples
    }
  });

  it('gives the takeover more time than its own 600 s default wherever the client cuts tool calls short', () => {
    expect(parse('codex.toml').mcp_servers.unstuck.tool_timeout_sec).toBeGreaterThan(600);
    expect(parse('gemini-settings.json').mcpServers.unstuck.timeout).toBeGreaterThan(600_000);
    expect(parse('copilot-mcp-config.json').mcpServers.unstuck.timeout).toBeGreaterThan(600_000);
    expect(parse('antigravity-mcp-config.json').mcpServers.unstuck.timeoutSeconds).toBeGreaterThan(600);
    expect(parse('pi-mcp.json').mcpServers.unstuck.timeout).toBeGreaterThan(600);
    expect(parse('goose.yaml').extensions.unstuck.timeout).toBeGreaterThan(600);
  });

  it('claude-code.sh adds both servers with the same Chrome', () => {
    const sh = read('claude-code.sh');
    expect(sh).toContain(`claude mcp add unstuck -e UNSTUCK_CDP_URL=${CDP} -- npx ${ENGINE.join(' ')}`);
    expect(sh).toContain(`claude mcp add playwright -- npx -y @playwright/mcp@0.0.85 --cdp-endpoint ${CDP}`);
  });

  it('the folder README names every file', () => {
    const readme = read('README.md');
    for (const f of files) expect(readme, f).toContain(`\`${f}\``);
  });
});
