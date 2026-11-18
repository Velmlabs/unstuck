// Sealed sample alerts for apps that unseal natively (apps/android): each vector must open with this package's own
// openAlert, so an app test that decrypts them checks the app against exactly what Cloud sends.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAlert } from '../src/alerts';
import { b64urlDecode, b64urlEncode } from '../src/e2e';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/alert-vectors.json');

/** The fixture's base64url fields always decode; a bad one fails the test here. */
function decode(s: string): Uint8Array<ArrayBuffer> {
  const b = b64urlDecode(s);
  if (!b) throw new Error(`not base64url: ${s.slice(0, 16)}…`);
  return new Uint8Array(b);
}

describe('alert vectors', () => {
  it('every vector opens with openAlert to its payload, and a flipped byte does not', async () => {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    const key = await crypto.subtle.importKey('pkcs8', decode(v.devicePrivateKeyPkcs8), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    expect(v.vectors.length).toBeGreaterThanOrEqual(3);
    expect(v.vectors.map((x: { payload: { mode?: string } }) => x.payload.mode ?? 'takeover')).toEqual(expect.arrayContaining(['takeover', 'approval', 'question']));
    for (const x of v.vectors) {
      expect(await openAlert(key, x.deviceId, x.sessionId, x.blob)).toEqual(x.payload);
      const bytes = decode(x.blob);
      bytes[bytes.length - 1]! ^= 1;
      expect(await openAlert(key, x.deviceId, x.sessionId, b64urlEncode(bytes))).toBeNull();
    }
  });
});
