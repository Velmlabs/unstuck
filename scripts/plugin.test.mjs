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
    for (const tool of ['request_human_takeover', 'start_human_takeover', 'wait_for_human_takeover', 'cancel_human_takeover']) {
      expect(skill).toContain(`\`${tool}\``);
      expect(mcp).toContain(`'${tool}'`);
    }
  });

  it('names the published packages and every result status', () => {
    expect(skill).toContain("npm install @velmlabs/unstuck");
    expect(skill).toContain('pip install unstuck');
    for (const s of ['resolved', 'cancelled', 'timed_out', 'failed']) expect(skill).toContain(`| \`${s}\``);
    expect(read('protocol/src/result.ts')).toContain("'resolved' | 'timed_out' | 'cancelled' | 'failed'");
  });
});
