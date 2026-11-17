import { describe, it, expect } from 'vitest';
import type { CdpClient } from '@velmlabs/unstuck-core';
import { formatAxNodes, takeSnapshot, MAX_SNAPSHOT_LINES, type AXNode } from '../src/browser/snapshot';

let id = 0;
const node = (role: string, name = '', o: Partial<AXNode> = {}): AXNode => ({ nodeId: String(++id), role: { value: role }, name: { value: name }, childIds: [], ...o });
/** A root over `top`; `nested` are nodes only reached through a parent's childIds. */
function tree(top: AXNode[], nested: AXNode[] = []): AXNode[] {
  const root = node('RootWebArea', 'Sign in', { childIds: top.map((c) => c.nodeId) });
  return [root, ...top, ...nested];
}

const LOGIN_AX = tree([
  node('heading', 'Sign in', { properties: [{ name: 'level', value: { value: 1 } }] }),
  node('textbox', 'Email', { value: { value: 'ana@example.com' }, backendDOMNodeId: 41 }),
  node('textbox', 'Password', { value: { value: 'hunter2' }, backendDOMNodeId: 42 }),
  node('button', 'Sign in', { backendDOMNodeId: 43 }),
]);

describe('formatAxNodes', () => {
  it('formats interactive nodes with refs, headings and text, and hides password values', () => {
    const s = formatAxNodes(LOGIN_AX, { url: 'https://app.example/login', title: 'Sign in' }, new Set([42]));
    expect(s.text).toBe(
      ['Page: Sign in', 'URL: https://app.example/login', '- heading "Sign in" [level=1]', '[e1] textbox "Email" value="ana@example.com"', '[e2] textbox "Password" value=<hidden>', '[e3] button "Sign in"'].join('\n'),
    );
    expect([...s.refs]).toEqual([['e1', 41], ['e2', 42], ['e3', 43]]);
    expect(s.text).not.toContain('hunter2');
  });

  it('text, checked, disabled, ignored nodes, long names and nested children', () => {
    const label = node('StaticText', '  Hello   world  ');
    const inLink = node('StaticText', 'Docs');
    const nodes = tree(
      [
      node('generic', '', { childIds: [label.nodeId] }),
      node('link', 'Docs', { backendDOMNodeId: 7, childIds: [inLink.nodeId] }),
      node('checkbox', 'Gift', { backendDOMNodeId: 8, properties: [{ name: 'checked', value: { value: 'true' } }, { name: 'disabled', value: { value: true } }] }),
      node('button', 'x'.repeat(200), { backendDOMNodeId: 9 }),
      node('button', 'Hidden', { backendDOMNodeId: 10, ignored: true }),
      node('button', 'No node'),
      ],
      [label, inLink],
    );
    const s = formatAxNodes(nodes, { url: 'u', title: 't' }, new Set());
    expect(s.text.split('\n').slice(2)).toEqual(['- text "Hello world"', '[e1] link "Docs"', '[e2] checkbox "Gift" checked=true disabled', `[e3] button "${'x'.repeat(120)}"`]);
  });

  it('a heading without a level is level 2; a null value shows nothing', () => {
    const s = formatAxNodes(tree([node('heading', 'Intro'), node('textbox', 'Q', { backendDOMNodeId: 3, value: { value: null } }), node('StaticText', '')]), { url: 'u', title: 't' }, new Set());
    expect(s.text.split('\n').slice(2)).toEqual(['- heading "Intro" [level=2]', '[e1] textbox "Q"']);
    expect(formatAxNodes([], { url: 'u', title: 't' }, new Set()).text).toBe('Page: t\nURL: u');
  });

  it(`stops at ${MAX_SNAPSHOT_LINES} lines and says how many are left`, () => {
    const s = formatAxNodes(tree(Array.from({ length: 450 }, (_, i) => node('button', `b${i}`, { backendDOMNodeId: 100 + i }))), { url: 'u', title: 't' }, new Set());
    const lines = s.text.split('\n');
    expect(lines).toHaveLength(2 + MAX_SNAPSHOT_LINES + 1);
    expect(lines.at(-1)).toBe('… 50 more elements (scroll, then snapshot again)');
    expect(s.refs.size).toBe(MAX_SNAPSHOT_LINES);
  });
});

describe('takeSnapshot', () => {
  const fake = (o: { ax?: () => unknown; noDom?: boolean }): CdpClient =>
    ({
      send: async (method: string, params?: { selector?: string; nodeId?: number }) => {
        if (method === 'Runtime.evaluate') return { result: { value: { url: 'https://x.example/', title: 'X', text: 'a'.repeat(3000) } } };
        if (method === 'Accessibility.getFullAXTree') return o.ax ? o.ax() : { nodes: LOGIN_AX };
        if (method === 'DOM.getDocument') {
          if (o.noDom) throw new Error("'DOM.getDocument' wasn't found");
          return { root: { nodeId: 1 } };
        }
        if (method === 'DOM.querySelectorAll') return { nodeIds: [5] };
        if (method === 'DOM.describeNode') return { node: { backendNodeId: 42 } };
        return {};
      },
      on: () => () => {},
      onClose: () => () => {},
    }) as unknown as CdpClient;

  it('finds password fields through the DOM', async () => {
    const s = await takeSnapshot(fake({}));
    expect(s.passwords).toEqual(new Set([42]));
    expect(s.text).toContain('[e2] textbox "Password" value=<hidden>');
    expect(s.url).toBe('https://x.example/');
  });

  it('a browser without the DOM domain still gets a snapshot (no password fields known)', async () => {
    const s = await takeSnapshot(fake({ noDom: true }));
    expect(s.passwords.size).toBe(0);
    expect(s.refs.size).toBe(3);
  });

  it('falls back to text when the AX tree is refused', async () => {
    const s = await takeSnapshot(
      fake({
        ax: () => {
          throw new Error("'Accessibility.getFullAXTree' wasn't found");
        },
      }),
    );
    expect(s.text).toBe(['Page: X', 'URL: https://x.example/', '(this browser gives no accessibility tree: refs are unavailable; use fetch_page to read the page)', 'a'.repeat(2000)].join('\n'));
    expect(s.refs.size).toBe(0);
  });
});
