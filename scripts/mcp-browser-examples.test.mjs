// examples/mcp-browser: each client config runs the published engine with its own browser (--mcp --browser) and gives a
// person time where the client cuts tool calls short. The README and the docs include these files.
import { readFileSync, readdirSync } from 'node:fs';
import { extname } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, it, expect } from 'vitest';

const dir = new URL('../examples/mcp-browser/', import.meta.url);
const read = (name) => readFileSync(new URL(name, dir), 'utf8');
const files = readdirSync(dir).filter((f) => f !== 'README.md').sort();
const ENGINE = ['npx', '-y', '@velmlabs/unstuck-engine', '--mcp', '--browser'];
const parse = (name) => ({ '.json': JSON.parse, '.toml': parseToml })[extname(name)](read(name));

describe('examples/mcp-browser', () => {
  it('has Claude Code, Claude Desktop and Codex', () => expect(files).toEqual(['claude-code.sh', 'claude-desktop.json', 'codex.toml']));

  it.each(files)('%s runs the published engine with --mcp --browser and a tool timeout of at least 900 s where the client has one', (name) => {
    if (name === 'claude-code.sh') {
      const sh = read(name);
      expect(sh).toContain(`claude mcp add unstuck -- ${ENGINE.join(' ')}`);
      expect(sh).not.toContain('UNSTUCK_CDP_URL'); // its own browser: nothing to connect to
      return;
    }
    const c = parse(name);
    const s = c.mcpServers?.unstuck ?? c.mcp_servers?.unstuck;
    expect([s.command, ...s.args]).toEqual(ENGINE);
    expect(s.env ?? {}).toEqual({});
    if (name === 'codex.toml') expect(s.tool_timeout_sec).toBeGreaterThanOrEqual(900);
  });

  it('the example README names every tool and says a person solves the checks', () => {
    const md = read(`${dir}/README.md`);
    for (const tool of ['fetch_page', 'get_session', 'forget_site', 'remember_site', 'resume_after_human', 'open', 'snapshot', 'click', 'type', 'select', 'scroll', 'wait_for', 'screenshot', 'ask_human', 'ask_question'])
      expect(md).toContain(`\`${tool}\``);
    expect(md).toContain("A person solves every check; the site's terms still apply.");
  });
});
