// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Readability } from '@mozilla/readability';
import { htmlToMarkdownInPage } from '../src/browser/markdown';
import { readInPage } from '../src/browser/extract';

const md = (html: string) => {
  document.body.innerHTML = html;
  return htmlToMarkdownInPage(document.body, 'https://shop.example/a/');
};

describe('htmlToMarkdownInPage (jsdom; the Chromium run is in extract.test.ts)', () => {
  it('headings, paragraphs, breaks, rules and emphasis', () => {
    expect(md('<h3> Title  here </h3><p>One<br>two</p><hr><p><b>bold</b> <i>it</i> <strong> </strong><em></em></p>')).toBe('### Title here\n\nOne\ntwo\n\n---\n\n**bold** *it*');
  });

  it('links and images are absolute; empty, javascript: and href-less links keep only their text', () => {
    expect(md('<p><a href="b">rel</a> <a href="javascript:void 0">js</a> <a>none</a> <a href="/x"></a> <img src="i.png" alt=" pic "> <img alt="no src"></p>')).toBe(
      '[rel](https://shop.example/a/b) js none ![pic](https://shop.example/a/i.png)',
    );
    expect(md('<a href="http://[bad">bad</a>')).toBe('[bad](http://[bad)');
  });

  it('lists: nested, ordered with a start, hidden items and stray li', () => {
    expect(md('<ul><li>a<ul><li>a1</li></ul></li><li hidden>gone</li><span>x</span></ul><ol start="3"><li>c</li><li>d</li></ol><li>stray</li>')).toBe('- a\n  - a1\n\n3. c\n4. d\n\n- stray');
    expect(md('<ol start="x"><li>one</li></ol><ul></ul>')).toBe('1. one');
  });

  it('code, pre (keeps its indentation), blockquote with blank lines', () => {
    expect(md('<p>run <code>a  b</code></p><pre>  if x:\n    y\n\n</pre><blockquote><p>q1</p><p>q2</p></blockquote>')).toBe('run `a b`\n\n```\n  if x:\n    y\n```\n\n> q1\n>\n> q2');
  });

  it('tables: header separator, ragged rows, pipes escaped, empty table', () => {
    expect(md('<table><tr><th>a|b</th><th>c</th></tr><tr><td>1</td></tr></table><table></table>')).toBe('| a\\|b | c |\n| --- | --- |\n| 1 | |');
  });

  it('skips scripts, styles, forms controls and hidden nodes (attribute, aria, inline style, computed)', () => {
    document.head.innerHTML = '<style>.gone{display:none}</style>';
    expect(md('<script>x()</script><style>p{}</style><button>b</button><p aria-hidden="true">a</p><p style="color:red; display: none">s</p><p style="visibility:hidden">v</p><p class="gone">c</p><div>kept</div><!-- c -->')).toBe('kept');
  });
});

describe('readInPage (jsdom)', () => {
  const run = (format: 'markdown' | 'text' | 'html', min = 200) => readInPage(format, min, htmlToMarkdownInPage, Readability as never);

  it('markdown from the Readability article, or the body when the article is too short', () => {
    document.title = 'Doc';
    document.body.innerHTML = `<article><h1>Doc</h1><p>${'Long enough text for an article. '.repeat(20)}</p></article><div class="cookie">Cookie banner</div>`;
    const r = run('markdown');
    expect(r.content).toContain('Long enough text');
    expect(r.contentType).toBe('text/html');
    document.body.innerHTML = '<p>tiny</p>';
    expect(run('markdown').content).toBe('tiny');
    expect(run('text').content).toContain('tiny');
    expect(run('html').content).toMatch(/^<html/);
  });

  it('falls back to the body when Readability throws', () => {
    document.body.innerHTML = '<p>body text</p>';
    const Broken = function () {
      throw new Error('nope');
    };
    expect(readInPage('markdown', 0, htmlToMarkdownInPage, Broken as never).content).toBe('body text');
  });
});
