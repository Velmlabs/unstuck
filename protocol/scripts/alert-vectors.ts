// Writes test/fixtures/alert-vectors.json: a device key (extractable, for this fixture only) and alerts sealed to it
// with sealAlert, as Cloud's engine-side sealing produces them. Apps that unseal natively test against this file.
//   npx tsx scripts/alert-vectors.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sealAlert, type AlertPayload } from '../src/alerts';
import { b64urlEncode } from '../src/e2e';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/alert-vectors.json');
const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
const devicePublicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
const devicePrivateKeyPkcs8 = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)));
const deviceId = 'dev_test_android_0001';
const expiresAt = 4102444800000; // 2100-01-01: never expired in a test
const payloads: [string, AlertPayload][] = [
  ['sess_takeover_0000001', { t: 'tok-takeover', k: 'key-takeover', reason: 'Solve the CAPTCHA', site: 'shop.example', expiresAt }],
  ['sess_approval_0000001', { t: 'tok-approval', k: 'key-approval', reason: 'mail.example asks you to approve a sign-in', site: 'mail.example', expiresAt, mode: 'approval' }],
  ['sess_question_0000001', { t: 'tok-question', k: 'key-question', reason: 'Your agent has a question', site: '', expiresAt, mode: 'question', question: 'Which flight should I book?' }],
];
const vectors = [];
for (const [sessionId, payload] of payloads) vectors.push({ deviceId, sessionId, blob: await sealAlert(devicePublicKey, deviceId, sessionId, payload), payload });
fs.writeFileSync(out, JSON.stringify({ devicePrivateKeyPkcs8, devicePublicKey, vectors }, null, 2) + '\n');
console.log(`wrote ${out}`);
