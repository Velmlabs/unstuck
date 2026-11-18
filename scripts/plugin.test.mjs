// The Claude Code plugin (plugins/unstuck): the skill must describe the real MCP tool and SDK, and ship with each release.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const json = (p) => JSON.parse(read(p));
const skill = read('plugins/unstuck/skills/unstuck/SKILL.md');
const mcp = read('engine/src/mcp.ts');

describe('unstuck plugin', () => {
  it('has the version of the packages it installs', () => {
    expect(json('plugins/unstuck/.claude-plugin/plugin.json').version).toBe(json('engine/package.json').version);
  });

  it('is listed in the marketplace at its own path', () => {
    const m = json('.claude-plugin/marketplace.json');
    expect(m.plugins).toEqual([expect.objectContaining({ name: 'unstuck', source: './plugins/unstuck' })]);
  });

  it('registers the published MCP server the README tells people to use', () => {
    const server = json('plugins/unstuck/.mcp.json').mcpServers.unstuck;
    expect(server).toEqual({ command: 'npx', args: ['-y', '@velmlabs/unstuck-engine', '--mcp', '--open'] });
    expect(read('README.md')).toContain('npx -y @velmlabs/unstuck-engine --mcp --open');
  });

  it('the skill has a name and a description an agent can match on', () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)[1];
    expect(front).toMatch(/^name: unstuck$/m);
    const description = /^description: (.+)$/m.exec(front)[1];
    expect(description.length).toBeLessThanOrEqual(1024);
    for (const word of ['CAPTCHA', '2FA', 'human']) expect(description).toContain(word);
  });

  it("documents exactly the MCP tools' arguments", () => {
    const real = [...new Set([...mcp.matchAll(/^\s{2,8}(\w+): z\b/gm)].map((m) => m[1]))].sort();
    const table = skill.slice(skill.indexOf('## MCP'), skill.indexOf('## Code'));
    const documented = [...table.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]).sort();
    expect(real.length).toBeGreaterThan(3);
    expect(documented).toEqual(real);
    expect(real).toEqual(expect.arrayContaining(['reason', 'alerts', 'takeover_id', 'max_wait_s']));
    for (const tool of ['request_human_takeover', 'start_human_takeover', 'wait_for_human_takeover', 'cancel_human_takeover', 'ask_question', 'resume_after_human']) {
      expect(skill).toContain(`\`${tool}\``);
      expect(mcp).toContain(`'${tool}'`);
    }
  });

  it('names the published packages and every result status', () => {
    expect(skill).toContain("npm install @velmlabs/unstuck");
    expect(skill).toContain('pip install unstuck');
    for (const s of ['resolved', 'answered', 'cancelled', 'timed_out', 'failed']) expect(skill).toContain(`| \`${s}\``);
    expect(read('protocol/src/result.ts')).toContain("'resolved' | 'answered' | 'timed_out' | 'cancelled' | 'failed'");
  });

  it('teaches shell agents the check → rescue → wait loop with the real exit codes', () => {
    const start = skill.indexOf('## Shell agents and agent-browser');
    expect(start).toBeGreaterThan(-1);
    const section = skill.slice(start, skill.indexOf('\n## ', start + 1));
    for (const s of ['unstuck check', 'unstuck rescue', 'unstuck wait', 'agent-browser get cdp-url', 'agent-browser tab list --json']) expect(section).toContain(s);
    const loop = /```sh\n([\s\S]*?)```/.exec(section)[1];
    expect(loop.indexOf('unstuck check')).toBeGreaterThan(-1);
    expect(loop.indexOf('unstuck check')).toBeLessThan(loop.indexOf('unstuck rescue'));
    expect(loop.indexOf('unstuck rescue')).toBeLessThan(loop.indexOf('unstuck wait'));
    expect(section).toMatch(/never solve a check yourself/i);
    expect(section).toMatch(/the link is for the person only/i);
    const exit = read('engine/src/shell/output.ts');
    const codes = Object.fromEntries([...exit.matchAll(/(\w+): (\d+)/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(codes)).toEqual(['done', 'humanNeeded', 'waiting', 'checkFound', 'failed', 'usage']);
    for (const [code, status] of [[codes.done, 'clear'], [codes.humanNeeded, 'human_needed'], [codes.waiting, 'waiting'], [codes.checkFound, 'check_found'], [codes.failed, 'failed'], [codes.usage, 'usage']]) {
      expect(section).toMatch(new RegExp(`\\| \`${code}\` \\|[^\\n]*${status}`));
    }
  });
});
