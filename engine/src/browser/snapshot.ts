// What the agent sees of a page: the accessibility tree as short lines, with refs (e1, e2…) on what it can act on.
import type { CdpClient } from '@velmlabs/unstuck-core';

export const MAX_SNAPSHOT_LINES = 400;
export const MAX_NAME_CHARS = 120;
const FALLBACK_TEXT_CHARS = 2000;
export const NO_AX_TREE = '(this browser gives no accessibility tree: refs are unavailable; use fetch_page to read the page)';

export interface AXValue {
  value?: unknown;
}
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface Snapshot {
  text: string;
  /** ref → backendDOMNodeId */
  refs: Map<string, number>;
  /** backendDOMNodeIds of password fields (their values are never shown, and type refuses them). */
  passwords: Set<number>;
  url?: string;
  title?: string;
}

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
]);

const str = (v: AXValue | undefined) => (v?.value === undefined || v.value === null ? '' : String(v.value));
const clean = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > MAX_NAME_CHARS ? t.slice(0, MAX_NAME_CHARS) : t;
};
const prop = (n: AXNode, name: string) => n.properties?.find((p) => p.name === name)?.value?.value;

/** The snapshot of an AX tree (pure). Text inside a link, button or heading is its name, so it isn't repeated. */
export function formatAxNodes(nodes: AXNode[], meta: { url: string; title: string }, passwords: Set<number>): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const lines: string[] = [];
  const refs = new Map<string, number>();
  let extra = 0;
  const emit = (line: string, backend?: number) => {
    if (lines.length >= MAX_SNAPSHOT_LINES) {
      extra++;
      return;
    }
    if (backend !== undefined) {
      const ref = `e${refs.size + 1}`;
      refs.set(ref, backend);
      line = `[${ref}] ${line}`;
    }
    lines.push(line);
  };
  const visit = (n: AXNode, named: boolean) => {
    const role = str(n.role);
    let covered = named;
    if (!n.ignored) {
      const name = clean(str(n.name));
      if (INTERACTIVE.has(role) && n.backendDOMNodeId !== undefined) {
        let line = `${role} "${name}"`;
        if (passwords.has(n.backendDOMNodeId)) line += ' value=<hidden>';
        else if (n.value && str(n.value) !== '') line += ` value="${clean(str(n.value))}"`;
        const checked = prop(n, 'checked');
        if (checked !== undefined) line += ` checked=${String(checked)}`;
        if (prop(n, 'disabled') === true) line += ' disabled';
        emit(line, n.backendDOMNodeId);
        covered = true;
      } else if (role === 'heading') {
        emit(`- heading "${name}" [level=${String(prop(n, 'level') ?? 2)}]`);
        covered = true;
      } else if (role === 'StaticText' && !named && name) emit(`- text "${name}"`);
    }
    for (const id of n.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, covered);
    }
  };
  if (nodes[0]) visit(nodes[0], false);
  if (extra > 0) lines.push(`… ${extra} more elements (scroll, then snapshot again)`);
  return { text: [`Page: ${meta.title}`, `URL: ${meta.url}`, ...lines].join('\n'), refs, passwords, url: meta.url, title: meta.title };
}

interface DomNode {
  nodeName?: string;
  backendNodeId?: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
}

/** A DOM node's attribute (CDP gives them as a flat name, value, name, value… list). */
export function attr(n: { attributes?: string[] }, name: string): string | undefined {
  const a = n.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) if (a[i]!.toLowerCase() === name) return a[i + 1];
  return undefined;
}

export const isPasswordInput = (n: DomNode): boolean => n.nodeName === 'INPUT' && attr(n, 'type')?.toLowerCase() === 'password';

/** Every password input, shadow roots (closed ones too) and frames included. */
async function passwordFields(cdp: CdpClient): Promise<Set<number>> {
  const out = new Set<number>();
  try {
    const { root } = await cdp.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: true });
    const walk = (n: DomNode) => {
      if (isPasswordInput(n) && n.backendNodeId !== undefined) out.add(n.backendNodeId);
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(c);
    };
    walk(root);
  } catch {
    // no DOM domain: no refs either (the AX tree is the only source of them)
  }
  return out;
}

export async function takeSnapshot(cdp: CdpClient): Promise<Snapshot> {
  const meta = (
    await cdp.send<{ result: { value: { url: string; title: string; text: string } } }>('Runtime.evaluate', {
      expression: `({ url: location.href, title: document.title, text: (document.body && document.body.innerText || '').slice(0, ${FALLBACK_TEXT_CHARS}) })`,
      returnByValue: true,
    })
  ).result.value;
  let nodes: AXNode[];
  try {
    nodes = (await cdp.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree')).nodes;
  } catch {
    return { text: [`Page: ${meta.title}`, `URL: ${meta.url}`, NO_AX_TREE, meta.text.slice(0, FALLBACK_TEXT_CHARS)].join('\n'), refs: new Map(), passwords: new Set(), url: meta.url, title: meta.title };
  }
  return formatAxNodes(nodes, meta, await passwordFields(cdp));
}
