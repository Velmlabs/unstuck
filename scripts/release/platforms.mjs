// The five engine builds and the npm manifests of the packages generated for them (publishing 0.1.0).
export const PLATFORMS = [
  { id: 'darwin-arm64', bun: 'bun-darwin-arm64', os: 'darwin', cpu: 'arm64', wheel: 'macosx_11_0_arm64', exe: 'unstuck-engine' },
  { id: 'darwin-x64', bun: 'bun-darwin-x64', os: 'darwin', cpu: 'x64', wheel: 'macosx_10_15_x86_64', exe: 'unstuck-engine' },
  { id: 'linux-x64', bun: 'bun-linux-x64', os: 'linux', cpu: 'x64', wheel: 'manylinux_2_17_x86_64', exe: 'unstuck-engine' },
  { id: 'linux-arm64', bun: 'bun-linux-arm64', os: 'linux', cpu: 'arm64', wheel: 'manylinux_2_17_aarch64', exe: 'unstuck-engine' },
  { id: 'win32-x64', bun: 'bun-windows-x64', os: 'win32', cpu: 'x64', wheel: 'win_amd64', exe: 'unstuck-engine.exe' },
];

const common = {
  license: 'Apache-2.0',
  author: 'Velm Labs',
  homepage: 'https://unstuck.sh/docs',
  bugs: { url: 'https://github.com/velmlabs/unstuck/issues' },
  repository: { type: 'git', url: 'git+https://github.com/velmlabs/unstuck.git', directory: 'engine' },
  publishConfig: { access: 'public' },
};

export function platformManifest(p, version) {
  return {
    name: `@velmlabs/unstuck-engine-${p.id}`,
    version,
    description: `The Unstuck engine binary for ${p.id}. Installed automatically by @velmlabs/unstuck-engine.`,
    ...common,
    os: [p.os],
    cpu: [p.cpu],
    files: ['bin'],
  };
}

export function launcherManifest(version) {
  return {
    name: '@velmlabs/unstuck-engine',
    version,
    description: 'The Unstuck engine and MCP server (npx -y @velmlabs/unstuck-engine --mcp). Human takeover for AI browser agents.',
    keywords: ['ai', 'agent', 'browser', 'mcp', 'captcha', 'human-in-the-loop', 'cdp'],
    ...common,
    type: 'module',
    bin: { 'unstuck-engine': 'bin/unstuck-engine.mjs' },
    files: ['bin'],
    engines: { node: '>=18' },
    optionalDependencies: Object.fromEntries(PLATFORMS.map((p) => [`@velmlabs/unstuck-engine-${p.id}`, version])),
  };
}
