// Builds the `unstuck` wheel once per platform: the engine binary goes into unstuck/_bin/, then the wheel is retagged
// for that platform. No sdist: it would lack the engine.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sdk = path.join(root, 'sdk-py');

export function buildWheel(platform, binary, out) {
  const binDir = path.join(sdk, 'src/unstuck/_bin');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wheel-'));
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.mkdirSync(binDir, { recursive: true });
  try {
    fs.copyFileSync(binary, path.join(binDir, platform.exe));
    fs.chmodSync(path.join(binDir, platform.exe), 0o755);
    // Built from a clean copy of the sources (no __pycache__), so nothing from the workspace leaks in.
    execFileSync('uv', ['build', '--wheel', '--no-build-logs', '--out-dir', work, sdk], { stdio: 'ignore', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
  const pure = fs.readdirSync(work).find((f) => f.endsWith('-py3-none-any.whl'));
  execFileSync('uvx', ['wheel==0.45.1', 'tags', '--platform-tag', platform.wheel, '--remove', path.join(work, pure)], { stdio: 'ignore' });
  const tagged = fs.readdirSync(work).find((f) => f.endsWith(`-${platform.wheel}.whl`));
  markPlatlib(path.join(work, tagged));
  fs.mkdirSync(out, { recursive: true });
  const dest = path.join(out, tagged);
  fs.copyFileSync(path.join(work, tagged), dest);
  return dest;
}

// A wheel with a native binary isn't pure Python: Root-Is-Purelib must be false so installers use platlib. The RECORD
// (file hashes) is updated to match.
const MARK_PLATLIB = `
import base64, hashlib, os, sys, zipfile
src = sys.argv[1]; tmp = src + ".tmp"
zin = zipfile.ZipFile(src)
items = [(i, zin.read(i.filename)) for i in zin.infolist()]
wheel = next(i.filename for i, _ in items if i.filename.endswith(".dist-info/WHEEL"))
record = next(i.filename for i, _ in items if i.filename.endswith(".dist-info/RECORD"))
def digest(b): return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b"=").decode()
out = []
for info, data in items:
    if info.filename == wheel: data = data.replace(b"Root-Is-Purelib: true", b"Root-Is-Purelib: false")
    out.append((info, data))
rows = []
for info, data in out:
    if info.filename != record: rows.append(f"{info.filename},{digest(data)},{len(data)}")
rows.append(f"{record},,")
out = [(i, ("\\n".join(rows) + "\\n").encode() if i.filename == record else d) for i, d in out]
with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
    for info, data in out: z.writestr(info, data)
os.replace(tmp, src)
`;

function markPlatlib(whl) {
  execFileSync('python3', ['-I', '-c', MARK_PLATLIB, whl]);
}
