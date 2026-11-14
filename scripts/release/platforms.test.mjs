import { describe, it, expect } from 'vitest';
import { PLATFORMS, platformManifest, launcherManifest } from './platforms.mjs';

describe('platform packages', () => {
  it('map each platform to a Bun target, npm os/cpu and a wheel tag', () => {
    expect(PLATFORMS).toEqual([
      { id: 'darwin-arm64', bun: 'bun-darwin-arm64', os: 'darwin', cpu: 'arm64', wheel: 'macosx_11_0_arm64', exe: 'unstuck-engine' },
      { id: 'darwin-x64', bun: 'bun-darwin-x64', os: 'darwin', cpu: 'x64', wheel: 'macosx_10_15_x86_64', exe: 'unstuck-engine' },
      { id: 'linux-x64', bun: 'bun-linux-x64', os: 'linux', cpu: 'x64', wheel: 'manylinux_2_17_x86_64', exe: 'unstuck-engine' },
      { id: 'linux-arm64', bun: 'bun-linux-arm64', os: 'linux', cpu: 'arm64', wheel: 'manylinux_2_17_aarch64', exe: 'unstuck-engine' },
      { id: 'win32-x64', bun: 'bun-windows-x64', os: 'win32', cpu: 'x64', wheel: 'win_amd64', exe: 'unstuck-engine.exe' },
    ]);
  });
  it('a platform package installs only on its own os/cpu and ships just the binary', () => {
    const m = platformManifest(PLATFORMS[4], '0.1.0');
    expect(m).toMatchObject({ name: '@velmlabs/unstuck-engine-win32-x64', version: '0.1.0', os: ['win32'], cpu: ['x64'], files: ['bin'], license: 'Apache-2.0', author: 'Velm Labs', homepage: 'https://unstuck.sh/docs' });
    expect(m.repository).toEqual({ type: 'git', url: 'git+https://github.com/velmlabs/unstuck.git', directory: 'engine' });
    expect(m.publishConfig).toEqual({ access: 'public' });
  });
  it('the launcher package has a bin and optional dependencies on every platform package, nothing else', () => {
    const m = launcherManifest('0.1.0');
    expect(m.name).toBe('@velmlabs/unstuck-engine');
    expect(m.bin).toEqual({ 'unstuck-engine': 'bin/unstuck-engine.mjs' });
    expect(m.type).toBe('module');
    expect(m.optionalDependencies).toEqual(Object.fromEntries(PLATFORMS.map((p) => [`@velmlabs/unstuck-engine-${p.id}`, '0.1.0'])));
    expect(m.dependencies).toBeUndefined();
    expect(m.files).toEqual(['bin']);
  });
});
