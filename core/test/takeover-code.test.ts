import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FakeCdp, FakeTransport } from '../src/testing';
import { createEngine, type LinkInfo } from '../src/engine';
import { MAX_CODE_ATTEMPTS } from '../src/session/takeover';
import type { TakeoverResult } from '@unstuck/protocol';

const realSetTimeout = globalThis.setTimeout;
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => realSetTimeout(r, 3));
}

function setup(requireCode: boolean | undefined, engineDefault?: boolean) {
  const transport = new FakeTransport();
  const cdp = new FakeCdp();
  const links: LinkInfo[] = [];
  const engine = createEngine({ transport, onLink: (l) => links.push(l), requireCode: engineDefault });
  let result: TakeoverResult | undefined;
  const done = engine.takeover(cdp, { reason: 'Log in', timeoutS: 600, requireCode }).then((r) => (result = r));
  const token = () => new URLSearchParams(new URL(links[0]!.url).hash.slice(1)).get('t')!;
  const open = () => transport.connect(links[0]!.url);
  const wrong = () => (links[0]!.code === '000000' ? '111111' : '000000');
  return { transport, engine, links, done, token, open, wrong, result: () => result };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(() => vi.useRealTimers());

describe('six-digit code', () => {
  it('onLink gets a 6-digit code that is not in the URL', async () => {
    const t = setup(true);
    await settle();
    expect(t.links[0]!.code).toMatch(/^\d{6}$/);
    expect(t.links[0]!.url).not.toContain(t.links[0]!.code!);
    await t.engine.close();
  });

  it('hello without a code gets code_required and the connection stays open for a second hello', async () => {
    const t = setup(true);
    await settle();
    const v = t.open();
    v.push({ t: 'hello', token: t.token() });
    await settle();
    expect(v.json()[0]).toMatchObject({ t: 'error', code: 'code_required' });
    expect(v.raw.closed).toBeNull();
    v.push({ t: 'hello', token: t.token(), code: t.links[0]!.code });
    await settle();
    expect(v.json()[1]).toMatchObject({ t: 'ready' });
    await t.engine.close();
  });

  it('a wrong code gets code_invalid and the connection stays open', async () => {
    const t = setup(true);
    await settle();
    const v = t.open();
    v.push({ t: 'hello', token: t.token(), code: t.wrong() });
    await settle();
    expect(v.json()[0]).toMatchObject({ t: 'error', code: 'code_invalid' });
    expect(v.raw.closed).toBeNull();
    await t.engine.close();
  });

  it('after 5 wrong codes new viewers are refused, the holder can still resume, and the takeover keeps waiting', async () => {
    expect(MAX_CODE_ATTEMPTS).toBe(5);
    const t = setup(true);
    await settle();
    const holder = t.open();
    holder.push({ t: 'hello', token: t.token(), code: t.links[0]!.code });
    await settle();
    const resumeKey = holder.json()[0].resumeKey;
    const guesser = t.open();
    for (let i = 0; i < 5; i++) guesser.push({ t: 'hello', token: t.token(), code: t.wrong() });
    await settle();
    const fresh = t.open();
    fresh.push({ t: 'hello', token: t.token(), code: t.links[0]!.code });
    await settle();
    expect(fresh.json()[0]).toMatchObject({ t: 'error', code: 'session_closed' });
    holder.close();
    await settle();
    const back = t.open();
    back.push({ t: 'hello', token: t.token(), resumeKey }); // resume needs no code
    await settle();
    expect(back.json()[0]).toMatchObject({ t: 'ready' });
    expect(t.result()).toBeUndefined();
    await t.engine.close();
  });

  it('a locked-out takeover times out normally', async () => {
    const t = setup(true);
    await settle();
    const guesser = t.open();
    for (let i = 0; i < 5; i++) guesser.push({ t: 'hello', token: t.token(), code: t.wrong() });
    await settle();
    expect(t.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600_000);
    await settle();
    expect(t.result()?.status).toBe('timed_out');
  });

  it('the engine default applies when the call does not say, and the call wins', async () => {
    const a = setup(undefined, true);
    await settle();
    expect(a.links[0]!.code).toMatch(/^\d{6}$/);
    await a.engine.close();
    const b = setup(false, true);
    await settle();
    expect(b.links[0]!.code).toBeUndefined();
    await b.engine.close();
  });

  it('without requireCode nothing changes', async () => {
    const t = setup(undefined);
    await settle();
    expect(t.links[0]!.code).toBeUndefined();
    const v = t.open();
    v.push({ t: 'hello', token: t.token() });
    await settle();
    expect(v.json()[0]).toMatchObject({ t: 'ready' });
    await t.engine.close();
  });
});
