// fetch_page's content: readable Markdown (Readability, then htmlToMarkdownInPage), text, or the page's HTML. Everything
// runs in the browser, in an isolated world, so the page's own scripts can't change what the agent reads.
import type { CdpClient } from '@velmlabs/unstuck-core';
import { htmlToMarkdownInPage } from './markdown';
import { READABILITY_JS } from './readability.gen';

export type ContentFormat = 'markdown' | 'text' | 'html';
export const MAX_CONTENT_CHARS = 100_000;
/** Readability output shorter than this (a login wall, an app shell) is not the page: use the whole body. */
const MIN_ARTICLE_CHARS = 200;

/** The tab shows a file fetch_page can't read as a page (a PDF). */
export class NotHtmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotHtmlError';
  }
}

export interface Extracted {
  title: string;
  content: string;
  truncated: boolean;
  contentType: string;
}

interface InPage {
  title: string;
  content: string;
  contentType: string;
  url: string;
}

/** The in-page program. `toMarkdown` and `Readability` are passed in, so this stays self-contained too. */
export function readInPage(format: ContentFormat, minArticle: number, toMarkdown: (root: Element, base: string) => string, R: new (doc: Document) => { parse(): { title?: string; content?: string; textContent?: string } | null }): InPage {
  const type = (document.contentType || 'text/html').toLowerCase();
  const base = { title: document.title, contentType: type, url: location.href };
  const raw = type === 'text/plain' || type === 'application/json' || /\+json$/.test(type);
  if (raw) return { ...base, content: document.body ? document.body.innerText : document.documentElement.textContent ?? '' };
  if (type === 'application/pdf') return { ...base, content: '' };
  if (format === 'html') return { ...base, content: document.documentElement.outerHTML };
  let root: Element = document.body ?? document.documentElement;
  let title = document.title;
  try {
    const article = new R(document.cloneNode(true) as Document).parse();
    if (article && article.content && (article.textContent ?? '').trim().length >= minArticle) {
      const holder = document.implementation.createHTMLDocument('').createElement('div');
      holder.innerHTML = article.content;
      root = holder;
      title = article.title || title;
    }
  } catch {
    // a page Readability can't parse: the whole body
  }
  const content = format === 'text' ? ((root as HTMLElement).innerText ?? root.textContent ?? '') : toMarkdown(root, location.href);
  return { ...base, title, content };
}

export async function extractPage(cdp: CdpClient, format: ContentFormat): Promise<Extracted> {
  const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
  const { executionContextId } = await cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'unstuck' });
  const expression = `(() => {
${READABILITY_JS}
;return (${readInPage.toString()})(${JSON.stringify(format)}, ${MIN_ARTICLE_CHARS}, ${htmlToMarkdownInPage.toString()}, Readability);
})()`;
  const r = await cdp.send<{ result?: { value?: InPage }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', {
    expression,
    contextId: executionContextId,
    returnByValue: true,
  });
  if (r.exceptionDetails || !r.result?.value) throw new Error(`could not read the page: ${r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text ?? 'no result'}`);
  const page = r.result.value;
  const contentType = page.contentType.split(';')[0]!.trim();
  if (contentType === 'application/pdf') {
    throw new NotHtmlError(`fetch_page reads web pages; ${page.url} is a application/pdf file. Use get_session and curl to download it.`);
  }
  let content = page.content;
  if (format === 'markdown' && page.title && !/^# /.test(content)) content = `# ${page.title}\n\n${content}`;
  const truncated = content.length > MAX_CONTENT_CHARS;
  return { title: page.title, content: truncated ? content.slice(0, MAX_CONTENT_CHARS) : content, truncated, contentType };
}
