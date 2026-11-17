import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode } from '../src/e2e';
import { exportDevicePublicKey, newDeviceKeyPair, openAlert, parseAlertFragment, sealAlert, type AlertPayload } from '../src/alerts';

const payload: AlertPayload = { t: 'tok', k: 'key', reason: 'captcha', site: 'example.com', expiresAt: 1_800_000_000_000 };

async function setup() {
  const pair = await newDeviceKeyPair();
  const pub = await exportDevicePublicKey(pair.publicKey);
  return { pair, pub };
}

describe('alert sealing', () => {
  it('exports a 65-byte uncompressed public key', async () => {
    const { pub } = await setup();
    const raw = b64urlDecode(pub)!;
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(4);
  });

  it('seal then open returns the payload', async () => {
    const { pair, pub } = await setup();
    const blob = await sealAlert(pub, 'dev_1', 'sess_1', payload);
    expect(await openAlert(pair.privateKey, 'dev_1', 'sess_1', blob)).toEqual(payload);
  });

  it('open is null for another device id', async () => {
    const { pair, pub } = await setup();
    const blob = await sealAlert(pub, 'dev_1', 'sess_1', payload);
    expect(await openAlert(pair.privateKey, 'dev_2', 'sess_1', blob)).toBeNull();
  });

  it('open is null for another session id', async () => {
    const { pair, pub } = await setup();
    const blob = await sealAlert(pub, 'dev_1', 'sess_1', payload);
    expect(await openAlert(pair.privateKey, 'dev_1', 'sess_2', blob)).toBeNull();
  });

  it('open is null for a tampered byte', async () => {
    const { pair, pub } = await setup();
    const raw = b64urlDecode(await sealAlert(pub, 'dev_1', 'sess_1', payload))!;
    raw[raw.length - 1]! ^= 1;
    expect(await openAlert(pair.privateKey, 'dev_1', 'sess_1', b64urlEncode(raw))).toBeNull();
  });

  it('open is null for another key pair', async () => {
    const { pub } = await setup();
    const other = await newDeviceKeyPair();
    const blob = await sealAlert(pub, 'dev_1', 'sess_1', payload);
    expect(await openAlert(other.privateKey, 'dev_1', 'sess_1', blob)).toBeNull();
  });

  it('open is null for a malformed blob', async () => {
    const { pair } = await setup();
    expect(await openAlert(pair.privateKey, 'dev_1', 'sess_1', '!!!')).toBeNull();
    expect(await openAlert(pair.privateKey, 'dev_1', 'sess_1', 'AAAA')).toBeNull();
    // right length, but the ephemeral key is not a valid curve point
    expect(await openAlert(pair.privateKey, 'dev_1', 'sess_1', b64urlEncode(new Uint8Array(65 + 12 + 16)))).toBeNull();
  });

  it('open is null when the plaintext is not an alert payload', async () => {
    const { pair, pub } = await setup();
    const bad = await sealAlert(pub, 'dev_1', 'sess_1', 'nope' as unknown as AlertPayload);
    expect(await openAlert(pair.privateKey, 'dev_1', 'sess_1', bad)).toBeNull();
  });

  it('sealing to an invalid public key throws', async () => {
    await expect(sealAlert('AAAA', 'dev_1', 'sess_1', payload)).rejects.toThrow();
    await expect(sealAlert('!!!', 'dev_1', 'sess_1', payload)).rejects.toThrow();
  });

  it('the private key is not extractable', async () => {
    const { pair } = await setup();
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();
  });

  it('two seals of the same payload differ', async () => {
    const { pub } = await setup();
    const a = await sealAlert(pub, 'dev_1', 'sess_1', payload);
    const b = await sealAlert(pub, 'dev_1', 'sess_1', payload);
    expect(a).not.toBe(b);
  });
});

describe('parseAlertFragment', () => {
  it('reads #x=<id>.<blob>', () => {
    expect(parseAlertFragment('#x=dev_1.AAA')).toEqual({ deviceId: 'dev_1', blob: 'AAA' });
    expect(parseAlertFragment('x=dev_1.AAA')).toEqual({ deviceId: 'dev_1', blob: 'AAA' });
  });
  it('rejects other fragments', () => {
    expect(parseAlertFragment('#t=abc&k=def')).toBeNull();
    expect(parseAlertFragment('#x=')).toBeNull();
    expect(parseAlertFragment('#x=nodot')).toBeNull();
    expect(parseAlertFragment('#x=.AAA')).toBeNull();
    expect(parseAlertFragment('#x=dev_1.')).toBeNull();
  });
});

describe('alert payload mode and question', () => {
  it('round-trips mode and question', async () => {
    const kp = await newDeviceKeyPair();
    const pub = await exportDevicePublicKey(kp.publicKey);
    const blob = await sealAlert(pub, 'dev', 'sess', { t: 'ask', k: 'key', reason: 'r', site: 's', expiresAt: 1, mode: 'question', question: 'Which?' });
    expect(await openAlert(kp.privateKey, 'dev', 'sess', blob)).toMatchObject({ mode: 'question', question: 'Which?' });
  });
});
