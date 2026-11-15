// Pins the viewer's script and stylesheet in index.html and pair.html with Subresource Integrity (SHA-384): a browser refuses an
// asset that differs from the build, wherever it is served from.
//   node scripts/integrity.mjs <dist dir> [base]
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `html` with integrity="sha384-…" on every script src / stylesheet href under `base`; `read(rel)` gives the bytes. */
export function withIntegrity(html, read, base = '/') {
  return html.replace(/<(script|link)\b([^>]*?)\s(src|href)="([^"]+)"([^>]*)>/g, (tag, name, before, attr, url, after) => {
    const isAsset = name === 'script' || /rel="stylesheet"/.test(tag);
    if (!isAsset) return tag;
    if (!url.startsWith(base)) throw new Error(`cannot pin ${url}`);
    const hash = createHash('sha384').update(read(url.slice(base.length))).digest('base64');
    return `<${name}${before} ${attr}="${url}" integrity="sha384-${hash}"${after}>`;
  });
}

/** Pins the script and stylesheet of every page in a build folder (index.html, pair.html). */
export function pinPages(dir, base = '/') {
  for (const page of ['index.html', 'pair.html']) {
    const file = path.join(dir, page);
    fs.writeFileSync(file, withIntegrity(fs.readFileSync(file, 'utf8'), (rel) => fs.readFileSync(path.join(dir, rel)), base));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [dir, base = '/'] = process.argv.slice(2);
  pinPages(dir, base);
}
