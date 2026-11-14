// Writes the generated engine packages (launcher + one per platform) into a staging folder, ready for `npm pack`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcherManifest, platformManifest } from './platforms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LICENSE = path.join(here, '../../engine/LICENSE');
const LICENSE_AGPL = path.join(here, '../../viewer/LICENSE');

/** Why a platform package carries two licences, and the AGPL source offer for the embedded viewer. */
export function notice(version) {
  return `Unstuck engine ${version}
Copyright Velm Labs.

The Unstuck engine is licensed under the Apache License 2.0 (SPDX: Apache-2.0; the text is in LICENSE).

This binary also contains the Unstuck viewer, the page shown to the person who takes over a browser. The viewer is
licensed under the GNU Affero General Public License v3.0 only (SPDX: AGPL-3.0-only; the text is in LICENSE-AGPL).

Source code offer: Velm Labs will provide the complete corresponding source code of the viewer in this version, for at
least three years from its release and at no more than the cost of providing it. Ask at support@unstuck.sh, naming the
version (${version}).
`;
}

function writePackage(dir, manifest, readme) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'README.md'), readme);
  fs.copyFileSync(LICENSE, path.join(dir, 'LICENSE'));
}

export function stageLauncher(out, version) {
  const dir = path.join(out, 'unstuck-engine');
  writePackage(
    dir,
    launcherManifest(version),
    `# @velmlabs/unstuck-engine\n\nThe [Unstuck](https://unstuck.sh) engine: the process that takes over a browser tab and serves the person's link. It is also an MCP server with one tool, \`request_human_takeover\`:\n\n\`\`\`bash\nnpx -y @velmlabs/unstuck-engine --mcp\n\`\`\`\n\nnpm installs only the build for your computer: macOS (Apple silicon or Intel), Linux (x64, arm64) or Windows x64. The SDK \`@velmlabs/unstuck\` uses it for you.\n\nDocs: https://unstuck.sh/docs/mcp/ · License: Apache-2.0\n`,
  );
  fs.copyFileSync(path.join(here, 'engine-launcher.mjs'), path.join(dir, 'bin/unstuck-engine.mjs'));
  fs.chmodSync(path.join(dir, 'bin/unstuck-engine.mjs'), 0o755);
  return dir;
}

export function stagePlatform(out, platform, binary, version) {
  const dir = path.join(out, `unstuck-engine-${platform.id}`);
  writePackage(dir, platformManifest(platform, version), `# @velmlabs/unstuck-engine-${platform.id}\n\nThe [Unstuck](https://unstuck.sh) engine binary for ${platform.id}. Installed automatically by \`@velmlabs/unstuck-engine\`; you don't need to install it yourself.\n`);
  fs.copyFileSync(LICENSE_AGPL, path.join(dir, 'LICENSE-AGPL'));
  fs.writeFileSync(path.join(dir, 'NOTICE'), notice(version));
  fs.copyFileSync(binary, path.join(dir, 'bin', platform.exe));
  fs.chmodSync(path.join(dir, 'bin', platform.exe), 0o755);
  return dir;
}
