// The edge entry of the published SDK must bundle for workerd with no Node built-in anywhere in its graph, third-party
// dependencies included (it bundles the real installed artifact, not the sources).
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

const MAX_BYTES = 1048576;
const STUB = "import { Unstuck } from '@velmlabs/unstuck';\nexport default { fetch() { return new Response(typeof Unstuck) } };\n";
const isBuiltin = (id) => id.startsWith('node:') || builtinModules.includes(id.split('/')[0]);

/** Bundles `@velmlabs/unstuck` as resolved from `appDir` (a folder with the packages installed) for workerd; throws if a Node built-in is needed. */
export async function edgeSmoke(appDir) {
  const entry = path.join(appDir, 'edge-smoke-entry.mjs');
  fs.writeFileSync(entry, STUB);
  let result;
  try {
    result = await build({
      entryPoints: [entry],
      absWorkingDir: appDir,
      bundle: true,
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'import'],
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
  } catch (e) {
    const texts = (e.errors ?? []).map((m) => m.text);
    const builtins = texts.map((t) => /Could not resolve "([^"]+)"/.exec(t)?.[1]).filter((id) => id && isBuiltin(id));
    if (builtins.length) throw new Error(`edge entry pulls in Node built-ins: ${[...new Set(builtins)].join(', ')}`);
    throw new Error(`edge entry does not bundle for workerd:\n${texts.join('\n') || e.message}`);
  } finally {
    fs.rmSync(entry, { force: true });
  }
  const inputs = Object.keys(result.metafile.inputs);
  const nodeInputs = inputs.filter((i) => i.startsWith('node:') || isBuiltin(i));
  if (nodeInputs.length) throw new Error(`edge entry pulls in Node built-ins: ${nodeInputs.join(', ')}`);
  const bytes = result.outputFiles.reduce((n, f) => n + f.contents.length, 0);
  if (bytes > MAX_BYTES) throw new Error(`edge bundle is ${(bytes / 1024).toFixed(0)} KiB (limit 1024 KiB)`);
  return { bytes, inputs: inputs.length };
}
