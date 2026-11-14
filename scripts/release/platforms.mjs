// The five engine builds and the npm manifests of the packages generated for them (publishing 0.1.0).
export const PLATFORMS = [
  // macOS 13: Bun's binaries are built for it (LC_BUILD_VERSION minos 13.0), so the wheel tag must not claim older.
  { id: 'darwin-arm64', bun: 'bun-darwin-arm64', os: 'darwin', cpu: 'arm64', wheel: 'macosx_13_0_arm64', exe: 'unstuck-engine', minMacos: '13.0' },
  // x64: Bun's baseline builds, so CPUs without AVX2 (older machines, many VMs, Rosetta before macOS 15) can run them.
  { id: 'darwin-x64', bun: 'bun-darwin-x64-baseline', os: 'darwin', cpu: 'x64', wheel: 'macosx_13_0_x86_64', exe: 'unstuck-engine', minMacos: '13.0' },
  { id: 'linux-x64', bun: 'bun-linux-x64-baseline', os: 'linux', cpu: 'x64', libc: 'glibc', wheel: 'manylinux_2_17_x86_64', exe: 'unstuck-engine' },
  { id: 'linux-arm64', bun: 'bun-linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc', wheel: 'manylinux_2_17_aarch64', exe: 'unstuck-engine' },
  { id: 'win32-x64', bun: 'bun-windows-x64-baseline', os: 'win32', cpu: 'x64', wheel: 'win_amd64', exe: 'unstuck-engine.exe' },
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
    // The binary embeds the viewer, which is AGPL-3.0-only (see NOTICE for the source offer).
    license: 'Apache-2.0 AND AGPL-3.0-only',
    os: [p.os],
    cpu: [p.cpu],
    ...(p.libc ? { libc: [p.libc] } : {}),
    preferUnplugged: true,
    files: ['bin', 'LICENSE-AGPL', 'NOTICE'],
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
