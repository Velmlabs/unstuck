import { describe, it, expect } from 'vitest';
import { PLATFORMS, platformManifest, launcherManifest } from './platforms.mjs';

const byId = (id) => PLATFORMS.find((p) => p.id === id);

describe('platform packages', () => {
  it('map each platform to a Bun target, npm os/cpu and a wheel tag', () => {
    expect(PLATFORMS).toEqual([
      // macOS 13: Bun's binaries are built for it (LC_BUILD_VERSION minos 13.0), so the wheel tag must not claim older.
      { id: 'darwin-arm64', bun: 'bun-darwin-arm64', os: 'darwin', cpu: 'arm64', wheel: 'macosx_13_0_arm64', exe: 'unstuck-engine', minMacos: '13.0' },
      // Intel Macs: Bun's build keeps Bun's own signature, which no longer matches, so it's re-signed ad-hoc (resign).
      // x64: Bun's baseline builds, so CPUs without AVX2 (older machines, many VMs) can run them.
      { id: 'darwin-x64', bun: 'bun-darwin-x64-baseline', os: 'darwin', cpu: 'x64', wheel: 'macosx_13_0_x86_64', exe: 'unstuck-engine', minMacos: '13.0', resign: true },
      { id: 'linux-x64', bun: 'bun-linux-x64-baseline', os: 'linux', cpu: 'x64', libc: 'glibc', wheel: 'manylinux_2_17_x86_64', exe: 'unstuck-engine' },
      { id: 'linux-arm64', bun: 'bun-linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc', wheel: 'manylinux_2_17_aarch64', exe: 'unstuck-engine' },
      { id: 'win32-x64', bun: 'bun-windows-x64-baseline', os: 'win32', cpu: 'x64', wheel: 'win_amd64', exe: 'unstuck-engine.exe' },
    ]);
  });
  it('a platform package installs only on its own os/cpu and ships just the binary', () => {
    const m = platformManifest(byId('win32-x64'), '0.1.3');
    expect(m).toMatchObject({ name: '@velmlabs/unstuck-engine-win32-x64', version: '0.1.3', os: ['win32'], cpu: ['x64'], files: ['bin'], author: 'Velm Labs', homepage: 'https://unstuck.sh/docs' });
    // Engine and embedded viewer are both Apache-2.0.
    expect(m.license).toBe('Apache-2.0');
    // Yarn PnP must unpack it to run it; and only glibc Linux gets the glibc builds (Alpine would fail to start them).
    expect(m.preferUnplugged).toBe(true);
    expect(m.libc).toBeUndefined();
    expect(platformManifest(byId('linux-x64'), '0.1.3').libc).toEqual(['glibc']);
    expect(m.repository).toEqual({ type: 'git', url: 'git+https://github.com/velmlabs/unstuck.git', directory: 'engine' });
    expect(m.publishConfig).toEqual({ access: 'public' });
  });
  it('an Intel Mac package installs on darwin/x64 only', () => {
    expect(platformManifest(byId('darwin-x64'), '0.1.3')).toMatchObject({ name: '@velmlabs/unstuck-engine-darwin-x64', os: ['darwin'], cpu: ['x64'] });
    expect(platformManifest(byId('darwin-x64'), '0.1.3').libc).toBeUndefined();
  });
  it('the launcher package has a bin and optional dependencies on every platform package, nothing else', () => {
    const m = launcherManifest('0.1.3');
    expect(m.name).toBe('@velmlabs/unstuck-engine');
    expect(m.bin).toEqual({ 'unstuck-engine': 'bin/unstuck-engine.mjs' });
    expect(m.type).toBe('module');
    expect(m.optionalDependencies).toEqual(Object.fromEntries(PLATFORMS.map((p) => [`@velmlabs/unstuck-engine-${p.id}`, '0.1.3'])));
    expect(m.dependencies).toBeUndefined();
    expect(m.files).toEqual(['bin']);
  });
});
