/**
 * HTML → Markdown, run inside the page (fetch_page serializes it with `.toString()`), so it must stay self-contained:
 * no imports, no outer variables, no helpers a compiler could hoist out of it.
 */
export function htmlToMarkdownInPage(root: Element, baseUrl: string): string {
  const SKIP = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'HEAD', 'BUTTON', 'SELECT', 'INPUT', 'TEXTAREA', 'OBJECT', 'CANVAS'];
  const BLOCK = ['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'FIGURE', 'FIGCAPTION', 'DL', 'DT', 'DD', 'DETAILS', 'SUMMARY', 'FORM', 'FIELDSET', 'ADDRESS'];
  const abs = (u: string): string => {
    try {
      return new URL(u, baseUrl).href;
    } catch {
      return u;
    }
  };
  const hidden = (el: Element): boolean => {
    if ((el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true') return true;
    if (/(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(el.getAttribute('style') ?? '')) return true;
    const view = el.ownerDocument.defaultView;
    if (!view) return false;
    const cs = view.getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden';
  };
  const cell = (s: string): string => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

  const list = (el: Element, depth: number): string => {
    const ordered = el.tagName === 'OL';
    let n = Number(el.getAttribute('start') ?? '1') || 1;
    const lines: string[] = [];
    for (const li of Array.from(el.children)) {
      if (li.tagName !== 'LI' || hidden(li)) continue;
      let text = '';
      const nested: string[] = [];
      for (const child of Array.from(li.childNodes)) {
        if (child.nodeType === 1 && ((child as Element).tagName === 'UL' || (child as Element).tagName === 'OL')) nested.push(list(child as Element, depth + 1));
        else text += render(child);
      }
      const marker = ordered ? `${n++}. ` : '- ';
      lines.push('  '.repeat(depth) + marker + text.replace(/\s*\n+\s*/g, ' ').trim());
      for (const sub of nested) if (sub) lines.push(sub);
    }
    return lines.join('\n');
  };

  const table = (el: Element): string => {
    const rows = Array.from(el.querySelectorAll('tr')).map((tr) => Array.from(tr.children).filter((c) => c.tagName === 'TD' || c.tagName === 'TH').map((c) => cell(inner(c))));
    if (rows.length === 0) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
    return [line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n');
  };

  const inner = (el: Node): string => {
    let out = '';
    for (const child of Array.from(el.childNodes)) out += render(child);
    return out;
  };

  const render = (node: Node): string => {
    if (node.nodeType === 3) return (node.textContent ?? '').replace(/\s+/g, ' ');
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.includes(tag) || hidden(el)) return '';
    const h = /^H([1-6])$/.exec(tag);
    if (h) return `\n\n${'#'.repeat(Number(h[1]))} ${inner(el).replace(/\s+/g, ' ').trim()}\n\n`;
    switch (tag) {
      case 'BR':
        return '\n';
      case 'HR':
        return '\n\n---\n\n';
      case 'A': {
        const text = inner(el).replace(/\s+/g, ' ').trim();
        const href = el.getAttribute('href');
        if (!text || !href || /^javascript:/i.test(href)) return text;
        return `[${text}](${abs(href)})`;
      }
      case 'IMG': {
        const src = el.getAttribute('src');
        return src ? `![${(el.getAttribute('alt') ?? '').trim()}](${abs(src)})` : '';
      }
      case 'STRONG':
      case 'B': {
        const t = inner(el).trim();
        return t ? `**${t}**` : '';
      }
      case 'EM':
      case 'I': {
        const t = inner(el).trim();
        return t ? `*${t}*` : '';
      }
      case 'CODE':
        return `\`${(el.textContent ?? '').replace(/\s+/g, ' ')}\``;
      case 'PRE':
        return `\n\n\`\`\`\n${(el.textContent ?? '').replace(/\n+$/, '')}\n\`\`\`\n\n`;
      case 'BLOCKQUOTE': {
        const body = inner(el).replace(/\n{3,}/g, '\n\n').trim();
        return `\n\n${body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n`;
      }
      case 'UL':
      case 'OL':
        return `\n\n${list(el, 0)}\n\n`;
      case 'TABLE':
        return `\n\n${table(el)}\n\n`;
      case 'LI':
        return `\n- ${inner(el).trim()}\n`;
      default:
        return BLOCK.includes(tag) ? `\n\n${inner(el)}\n\n` : inner(el);
    }
  };

  // Tidy whitespace outside code fences: list items keep their indent, other lines are trimmed.
  const lines: string[] = [];
  let inFence = false;
  for (const line of render(root).split('\n')) {
    if (line === '```') inFence = !inFence;
    if (inFence || line === '```') lines.push(line);
    else if (/^ *(- |\d+\. )/.test(line)) lines.push(line.replace(/\s+$/, '').replace(/(\S) {2,}/g, '$1 '));
    else lines.push(line.trim().replace(/ {2,}/g, ' '));
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
