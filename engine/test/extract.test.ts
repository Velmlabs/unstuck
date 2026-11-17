import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { CdpClient } from '@velmlabs/unstuck-core';
import { startChromium, type DebugChromium } from './chromium';
import { connectCdp, type DirectCdp } from '../src/direct-cdp';
import { extractPage, MAX_CONTENT_CHARS, NotHtmlError } from '../src/browser/extract';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'extract');
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

let chrome: DebugChromium;
let server: http.Server;
let base = '';
let tab: DirectCdp;

const pages: Record<string, { type: string; body: () => string }> = {
  '/article': { type: 'text/html; charset=utf-8', body: () => fs.readFileSync(path.join(DIR, 'article.html'), 'utf8') },
  '/tamper': { type: 'text/html; charset=utf-8', body: () => fs.readFileSync(path.join(DIR, 'tamper.html'), 'utf8') },
  '/short': { type: 'text/html; charset=utf-8', body: () => '<!doctype html><title>Short</title><body><p>Just one line.</p></body>' },
  '/long': { type: 'text/html; charset=utf-8', body: () => `<!doctype html><title>Long</title><body><article><p>${'word '.repeat(30_000)}</p></article></body>` },
  '/data.json': { type: 'application/json', body: () => '{"ok":true,"items":[1,2]}' },
  '/note.txt': { type: 'text/plain; charset=utf-8', body: () => '{"ok":true,"items":[1,2]}' },
  '/feed': { type: 'application/ld+json', body: () => '{"ok":true,"items":[1,2]}' },
  '/doc.pdf': { type: 'application/pdf', body: () => PDF },
};

async function open(p: string): Promise<CdpClient> {
  await tab.send('Page.enable');
  const loaded = new Promise<void>((r) => {
    const off = tab.on('Page.loadEventFired', () => {
      off();
      r();
    });
  });
  await tab.send('Page.navigate', { url: base + p });
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 3000))]);
  return tab;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const page = pages[req.url ?? ''];
    if (!page) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': page.type });
    res.end(page.body());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  chrome = await startChromium();
  tab = await connectCdp(`http://127.0.0.1:${chrome.port}`);
}, 30_000);

afterAll(async () => {
  await tab?.close();
  await chrome?.stop();
  await new Promise((r) => server.close(r));
});

describe('extractPage', () => {
  it('markdown keeps the article: title, headings, links made absolute, lists and code', async () => {
    const r = await extractPage(await open('/article'), 'markdown');
    expect(r.title).toBe('Shipping times');
    expect(r.contentType).toBe('text/html');
    expect(r.truncated).toBe(false);
    expect(r.content).toContain('# Shipping times');
    expect(r.content).toContain('## Where we ship');
    expect(r.content).toContain(`[returns policy](${base}/policies/returns)`);
    expect(r.content).toContain('**two to four working days**');
    expect(r.content).toContain('*express*');
    expect(r.content).toContain('```\nnpm install @shop/track\ntrack 12345\n```');
    expect(r.content).toContain('`track <order>`');
    expect(r.content).toMatch(/- Europe\n {2}- Netherlands\n {2}- Belgium\n- United Kingdom/);
    expect(r.content).toMatch(/1\. Pack the item\n2\. Print the label/);
    expect(r.content).toContain('> Fast and friendly, my parcel came in two days.');
    expect(r.content).toContain(`![Delivery van](${base}/img/van.png)`);
    expect(r.content).toContain('| Zone | Days |\n| --- | --- |\n| EU | 2-4 |\n| UK | 3-5 |');
    expect(r.content).not.toContain('Cookie banner'); // boilerplate dropped by readability
    expect(r.content).not.toContain('Hidden paragraph');
    expect(r.content).not.toContain('document.write');
    expect(r.content).not.toMatch(/\n{3,}/);
  });

  it('text and html formats', async () => {
    await open('/article');
    const text = await extractPage(tab, 'text');
    expect(text.content).toContain('Orders placed before 2 pm ship the same day.');
    expect(text.content).not.toContain('](');
    const html = await extractPage(tab, 'html');
    expect(html.content.startsWith('<html')).toBe(true);
    expect(html.content).toContain('Cookie banner'); // the whole page, as it is
  });

  it('a short page falls back to the whole body', async () => {
    const r = await extractPage(await open('/short'), 'markdown');
    expect(r.content).toContain('Just one line.');
    expect(r.title).toBe('Short');
  });

  it('a page script cannot tamper with the extractor (isolated world)', async () => {
    await open('/tamper');
    const r = await extractPage(tab, 'markdown');
    expect(r.content).toContain('This page tries to break the extractor');
    expect((await extractPage(tab, 'text')).content).not.toContain('TAMPERED');
  });

  it('content over 100 000 chars is truncated and says so', async () => {
    const r = await extractPage(await open('/long'), 'text');
    expect(r.truncated).toBe(true);
    expect(r.content).toHaveLength(MAX_CONTENT_CHARS);
  });

  // Review Focus 5
  it('JSON and plain text come back as their raw text in every format', async () => {
    for (const p of ['/data.json', '/note.txt', '/feed']) {
      await open(p);
      for (const f of ['markdown', 'text', 'html'] as const) expect((await extractPage(tab, f)).content).toBe('{"ok":true,"items":[1,2]}');
    }
  });

  it('a PDF is a clear NotHtmlError naming get_session and curl', async () => {
    await open('/doc.pdf');
    const err = await extractPage(tab, 'markdown').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotHtmlError);
    expect((err as Error).message).toBe(`fetch_page reads web pages; ${base}/doc.pdf is a application/pdf file. Use get_session and curl to download it.`);
  });

  it('an evaluation that throws is an error, not empty content', async () => {
    const fake: CdpClient = {
      send: (async (method: string) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F' } } };
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
        return { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } } };
      }) as CdpClient['send'],
      on: () => () => {},
      onClose: () => () => {},
    };
    await expect(extractPage(fake, 'markdown')).rejects.toThrow('could not read the page: Error: boom');
  });
});
