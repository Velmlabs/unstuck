// Child process for the two-processes-on-one-profile test: 50 × (save + count a rescue) on one sites.json.
import { createFileSessionStore } from '@velmlabs/unstuck-core';
import { nodeStoreFs } from '../../src/browser/node-store-fs';

const [file, site] = process.argv.slice(2) as [string, string];
const s = createFileSessionStore(nodeStoreFs(), file);
for (let i = 0; i < 50; i++) {
  await s.save(site, [{ name: `c${i}`, value: String(i), domain: site, path: '/', expires: -1, httpOnly: false, secure: true }], 'UA');
  await s.updateRescues((t) => [...t, Date.now()]);
}
