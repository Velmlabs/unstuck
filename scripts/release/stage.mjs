// Writes the generated engine packages (launcher + one per platform) into a staging folder, ready for `npm pack`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcherManifest, platformManifest } from './platforms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LICENSE = path.join(here, '../../engine/LICENSE');

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
    `# @velmlabs/unstuck-engine\n\nThe [Unstuck](https://unstuck.sh) engine: the process that takes over a browser tab and serves the person's link. It is also an MCP server with one tool, \`request_human_takeover\`:\n\n\`\`\`bash\nnpx -y @velmlabs/unstuck-engine --mcp\n\`\`\`\n\nnpm installs only the build for your computer (macOS, Linux, Windows). The SDK \`@velmlabs/unstuck\` uses it for you.\n\nDocs: https://unstuck.sh/docs/mcp/ · License: Apache-2.0\n`,
  );
  fs.copyFileSync(path.join(here, 'engine-launcher.mjs'), path.join(dir, 'bin/unstuck-engine.mjs'));
  fs.chmodSync(path.join(dir, 'bin/unstuck-engine.mjs'), 0o755);
  return dir;
}

export function stagePlatform(out, platform, binary, version) {
  const dir = path.join(out, `unstuck-engine-${platform.id}`);
  writePackage(dir, platformManifest(platform, version), `# @velmlabs/unstuck-engine-${platform.id}\n\nThe [Unstuck](https://unstuck.sh) engine binary for ${platform.id}. Installed automatically by \`@velmlabs/unstuck-engine\`; you don't need to install it yourself.\n`);
  fs.copyFileSync(binary, path.join(dir, 'bin', platform.exe));
  fs.chmodSync(path.join(dir, 'bin', platform.exe), 0o755);
  return dir;
}
