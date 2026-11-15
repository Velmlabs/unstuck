import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Unstuck, type TakeoverLink } from '@velmlabs/unstuck';
import { createCloudAlerter } from '../engine/src/cloud-alerts';

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(import.meta.url)('playwright');
const ENGINE = path.resolve(here, '../engine/dist/unstuck-engine');
const CAPTCHA = fs.readFileSync(path.join(here, 'fixtures/fake-captcha.html'));
const API_KEY = 'e2e-api-key';
const CODE = 'GOOD-PAIRING-CODE';

/** A stand-in for Unstuck Cloud: the pair, devices and notify endpoints, and nothing else. */
let cloud: http.Server;
let apiBase = '';
let site: http.Server;
let siteUrl = '';
let devices: { id: string; publicKey: string; label: string }[] = [];
let notifies: { sessionId: string; viewerUrl: string; sealed: { device: string; blob: string }[] }[] = [];
let pairBodies: { code: string; publicKey: string; label: string }[] = [];
let agentBrowser: any;
let humanBrowser: any;

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' };

beforeAll(async () => {
  cloud = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => res.writeHead(status, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
      if (pathname === '/api/v1/devices/pair' && req.method === 'POST') {
        const b = JSON.parse(raw);
        if (b.code !== CODE) return send(410, { error: 'invalid_code' });
        pairBodies.push(b);
        devices.push({ id: 'dev-e2e', publicKey: b.publicKey, label: b.label });
        return send(200, { deviceId: 'dev-e2e', deviceToken: 'device-token' });
      }
      if (req.headers.authorization !== `Bearer ${API_KEY}`) return send(401, { error: 'unauthorized' });
      if (pathname === '/api/v1/agent/devices') return send(200, { devices: devices.map((d) => ({ id: d.id, publicKey: d.publicKey })) });
      if (pathname === '/api/v1/agent/notify' && req.method === 'POST') {
        notifies.push(JSON.parse(raw));
        return send(200, { ok: true });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => cloud.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
  site = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(CAPTCHA));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  agentBrowser = await chromium.launch();
  humanBrowser = await chromium.launch();
});
afterAll(async () => {
  await agentBrowser?.close();
  await humanBrowser?.close();
  cloud?.close();
  site?.close();
});

describe('a takeover alert reaches the paired phone, sealed', () => {
  it('pairs a browser, seals the link to it, opens a live takeover from the sealed link, and a browser that never paired is turned away', async () => {
    const agentPage = await agentBrowser.newPage();
    await agentPage.goto(siteUrl);
    let link!: TakeoverLink;
    let arrived!: () => void;
    const gotLink = new Promise<void>((r) => (arrived = r));
    const unstuck = new Unstuck({ enginePath: ENGINE, onLink: (l) => ((link = l), arrived()) });
    const result = unstuck.takeover(agentPage, { reason: 'Solve the test CAPTCHA', timeoutS: 90 });
    await gotLink;
    const viewer = new URL(link.url).origin;

    // The phone pairs: the pair page (served by the viewer build) makes the key and posts the code and public key.
    const phone = await humanBrowser.newContext();
    const pairPage = await phone.newPage();
    await pairPage.goto(`${viewer}/pair.html?api=${encodeURIComponent(apiBase)}#c=${CODE}`);
    await pairPage.getByRole('button', { name: 'Pair this phone' }).click();
    await pairPage.getByText(/this phone is paired/i).waitFor({ timeout: 15_000 });
    expect(pairPage.url()).not.toContain('#c=');
    expect(pairBodies).toHaveLength(1);
    expect(pairBodies[0]!.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);

    // The engine's alerter seals the link to that device and "sends" it to the fake Cloud.
    const log: string[] = [];
    await createCloudAlerter({ apiBase, apiKey: API_KEY, log: (l) => log.push(l) })({ sessionId: link.sessionId, url: link.url, reason: link.reason, expiresAt: link.expiresAt }, '127.0.0.1');
    expect(log).toEqual(['[unstuck] alert sealed to 1 phone(s): phone (dev-e2e)']);
    expect(notifies).toHaveLength(1);
    const n = notifies[0]!;
    // Everything Cloud received is ciphertext: neither the link secret nor the reason is in it.
    const secret = new URLSearchParams(link.url.split('#')[1]);
    const seen = JSON.stringify(n);
    expect(seen).not.toContain(secret.get('t')!);
    expect(seen).not.toContain(secret.get('k')!);
    expect(seen).not.toContain('Solve the test CAPTCHA');
    expect(n.viewerUrl).toBe(link.url.split('#')[0]);
    const sealedLink = `${n.viewerUrl}#x=${n.sealed[0]!.device}.${n.sealed[0]!.blob}`;

    // A browser that never paired sees the "phone you paired" page and never connects.
    const stranger = await humanBrowser.newContext();
    const strangerPage = await stranger.newPage();
    await strangerPage.goto(sealedLink);
    await strangerPage.getByRole('heading', { name: /open this link on the phone you paired/i }).waitFor({ timeout: 15_000 });
    expect(strangerPage.url()).not.toContain('#x=');
    expect(await strangerPage.locator('canvas').count()).toBe(0);
    await stranger.close();

    // The paired browser opens the sealed link: unsealed, live, and Done resolves the agent.
    const human = await phone.newPage();
    await human.goto(sealedLink);
    await human.waitForFunction(() => (document.querySelector('canvas') as HTMLCanvasElement | null)?.width! > 100, null, { timeout: 20_000 });
    expect(await human.getByText('Solve the test CAPTCHA').count()).toBe(1);
    // The engine's own viewer page allows no other origin (CSP connect-src 'self'), so it can't ask Cloud who sent the
    // alert: no key is named and no warning is shown (view.unstuck.sh's page allows the Cloud API).
    expect(await human.getByText(/From your key/).count()).toBe(0);
    expect(await human.getByText(/wasn't sent by Unstuck alerts/).count()).toBe(0);
    expect(human.url()).not.toContain('#');
    await human.getByRole('button', { name: 'Done' }).click();
    await expect(result).resolves.toMatchObject({ status: 'resolved', sessionId: link.sessionId });

    await phone.close();
    await unstuck.close();
    await agentPage.close();
  });

  it('an expired pairing code is refused with a clear message', async () => {
    const ctx = await humanBrowser.newContext();
    const page = await ctx.newPage();
    // Any origin that serves the viewer build will do; the engine started in the previous test is gone, so use a fresh one.
    const agentPage = await agentBrowser.newPage();
    await agentPage.goto(siteUrl);
    let link!: TakeoverLink;
    let arrived!: () => void;
    const gotLink = new Promise<void>((r) => (arrived = r));
    const unstuck = new Unstuck({ enginePath: ENGINE, onLink: (l) => ((link = l), arrived()) });
    const result = unstuck.takeover(agentPage, { reason: 'x', timeoutS: 30 });
    await gotLink;
    await page.goto(`${new URL(link.url).origin}/pair.html?api=${encodeURIComponent(apiBase)}#c=USED-CODE`);
    await page.getByRole('button', { name: 'Pair this phone' }).click();
    await page.getByText('This pairing code has expired. Make a new one in your dashboard.').waitFor({ timeout: 15_000 });
    await ctx.close();
    await unstuck.close();
    await result.catch(() => undefined);
    await agentPage.close();
  });
});
