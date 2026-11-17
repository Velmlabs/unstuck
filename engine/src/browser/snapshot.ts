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
/** One line (page titles and URLs can't add lines to the snapshot); not cut, unlike names. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
/** A page-written string inside quotes: one line, its own quotes escaped, so it can't pose as another line or ref. */
const quote = (s: string) => `"${clean(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const prop = (n: AXNode, name: string) => n.properties?.find((p) => p.name === name)?.value?.value;

/** The snapshot of an AX tree (pure). Text inside a link, button or heading is its name, so it isn't repeated. */
export function formatAxNodes(nodes: AXNode[], meta: { url: string; title: string }, passwords: Set<number>, secrets: Set<number> = new Set()): Snapshot {
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
        let line = `${role} ${quote(name)}`;
        if (passwords.has(n.backendDOMNodeId) || secrets.has(n.backendDOMNodeId)) line += ' value=<hidden>';
        else if (n.value && str(n.value) !== '') line += ` value=${quote(str(n.value))}`;
        const checked = prop(n, 'checked');
        if (checked !== undefined) line += ` checked=${String(checked)}`;
        if (prop(n, 'disabled') === true) line += ' disabled';
        emit(line, n.backendDOMNodeId);
        covered = true;
      } else if (role === 'heading') {
        emit(`- heading ${quote(name)} [level=${String(prop(n, 'level') ?? 2)}]`);
        covered = true;
      } else if (role === 'StaticText' && !named && name) emit(`- text ${quote(name)}`);
    }
    for (const id of n.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, covered);
    }
  };
  if (nodes[0]) visit(nodes[0], false);
  if (extra > 0) lines.push(`… ${extra} more elements (scroll, then snapshot again)`);
  const title = oneLine(meta.title);
  return { text: [`Page: ${title}`, `URL: ${oneLine(meta.url)}`, ...lines].join('\n'), refs, passwords, url: meta.url, title };
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

const SECRET_AUTOCOMPLETE = /^(cc-|one-time-code$|current-password$|new-password$)/;
const SECRET_NAME = /card|cc-?num|cvv|cvc|csc|otp|one.?time|totp|2fa|ssn|passcode|security.?code|(^|[_-])pin($|[_\d-])/i;

/** A field whose value is a secret even though it isn't type=password: a card number, a one-time code, a PIN. */
export function isSecretInput(n: DomNode): boolean {
  if (n.nodeName !== 'INPUT' && n.nodeName !== 'TEXTAREA') return false;
  if ((attr(n, 'autocomplete') ?? '').toLowerCase().split(/\s+/).some((t) => SECRET_AUTOCOMPLETE.test(t))) return true;
  return SECRET_NAME.test(attr(n, 'name') ?? '') || SECRET_NAME.test(attr(n, 'id') ?? '');
}

/** Every password input, and every other secret field, shadow roots (closed ones too) and frames included. */
async function sensitiveFields(cdp: CdpClient): Promise<{ passwords: Set<number>; secrets: Set<number> }> {
  const passwords = new Set<number>();
  const secrets = new Set<number>();
  try {
    const { root } = await cdp.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: true });
    const walk = (n: DomNode) => {
      if (n.backendNodeId !== undefined) {
        if (isPasswordInput(n)) passwords.add(n.backendNodeId);
        else if (isSecretInput(n)) secrets.add(n.backendNodeId);
      }
      for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(c);
    };
    walk(root);
  } catch {
    // no DOM domain: no refs either (the AX tree is the only source of them)
  }
  return { passwords, secrets };
}

/** The page's URL, title and opening text, read in an isolated world: page scripts can't redefine what we read. */
async function pageMeta(cdp: CdpClient): Promise<{ url: string; title: string; text: string }> {
  const expression = `({ url: location.href, title: document.title, text: (document.body && document.body.innerText || '').slice(0, ${FALLBACK_TEXT_CHARS}) })`;
  let contextId: number | undefined;
  try {
    const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    contextId = (await cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'unstuck' })).executionContextId;
  } catch {
    // a browser without isolated worlds: the page's own world
  }
  const r = await cdp.send<{ result: { value: { url: string; title: string; text: string } } }>('Runtime.evaluate', { expression, returnByValue: true, ...(contextId !== undefined ? { contextId } : {}) });
  return r.result.value;
}

export async function takeSnapshot(cdp: CdpClient): Promise<Snapshot> {
  const meta = await pageMeta(cdp);
  let nodes: AXNode[];
  try {
    nodes = (await cdp.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree')).nodes;
  } catch {
    return { text: [`Page: ${oneLine(meta.title)}`, `URL: ${oneLine(meta.url)}`, NO_AX_TREE, meta.text.slice(0, FALLBACK_TEXT_CHARS)].join('\n'), refs: new Map(), passwords: new Set(), url: meta.url, title: oneLine(meta.title) };
  }
  const { passwords, secrets } = await sensitiveFields(cdp);
  return formatAxNodes(nodes, meta, passwords, secrets);
}
