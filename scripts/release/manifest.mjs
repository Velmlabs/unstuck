// The dry run's record (release/dry-run-passed.json: the commit and each artifact's SHA-256) and the registry checks
// that let a stopped release be finished: a version is free, already published with these exact bytes, or taken.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RECORD = 'dry-run-passed.json';
const hash = (algo, file) => crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
export const sha1 = (file) => hash('sha1', file);
export const sha256 = (file) => hash('sha256', file);

/** `files` are relative to `out`. */
export function writeManifest(out, files, commit) {
  const record = { commit, files: Object.fromEntries(files.map((f) => [f, sha256(path.join(out, f))])) };
  fs.writeFileSync(path.join(out, RECORD), JSON.stringify(record, null, 2) + '\n');
}

/** Returns the recorded files (relative to `out`) once each still has the bytes the dry run passed, on this commit. */
export function verifyManifest(out, commit) {
  const file = path.join(out, RECORD);
  if (!fs.existsSync(file)) throw new Error(`no passed dry run in ${out}: run pnpm release first`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.commit !== commit) throw new Error(`the dry run passed for ${record.commit}, but HEAD is ${commit}: run pnpm release again`);
  for (const [f, digest] of Object.entries(record.files)) {
    if (!fs.existsSync(path.join(out, f))) throw new Error(`${f} is missing: run pnpm release again`);
    if (sha256(path.join(out, f)) !== digest) throw new Error(`${f} changed since the dry run: run pnpm release again`);
  }
  return Object.keys(record.files);
}

/** 'free', 'same' (this version is published with this tarball's sha1) or 'different'. */
export async function npmState(name, version, shasum, get = fetch) {
  const res = await get(`https://registry.npmjs.org/${name.replace('/', '%2f')}`);
  if (res.status === 404) return 'free';
  if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${name}`);
  const doc = await res.json();
  const published = doc.versions?.[version];
  // npm never lets a version be reused, even after it was unpublished (it stays in `time`).
  if (!published) return doc.time?.[version] ? 'different' : 'free';
  return published.dist?.shasum === shasum ? 'same' : 'different';
}

/** 'free', 'same' (this file is in the release with this sha256) or 'different'. */
export async function pypiState(project, version, filename, digest, get = fetch) {
  const res = await get(`https://pypi.org/pypi/${project}/${version}/json`);
  if (res.status === 404) return 'free';
  if (!res.ok) throw new Error(`PyPI answered ${res.status} for ${project} ${version}`);
  const file = (await res.json()).urls?.find((u) => u.filename === filename);
  if (!file) return 'free';
  return file.digests?.sha256 === digest ? 'same' : 'different';
}
