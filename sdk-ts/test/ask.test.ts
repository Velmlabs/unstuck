import { describe, it, expect, vi, afterEach } from 'vitest';
import { Unstuck, UnstuckConfigError, UnstuckEngineError } from '../src/index';
import { fakeEngine, launch } from './helpers';

/** A fake engine: hello with `caps`, then `onAsk` JS (m, out, note available) for an ask request. */
function askEngine(caps: string[] | null, onAsk: string, onTakeover = "out({ id: m.id, result: { status: 'resolved', sessionId: 's', url: 'u', durationS: 0, detail: JSON.stringify(m.params) } });") {
  return fakeEngine(`
import readline from 'node:readline';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const note = (method, params) => out({ method, params });
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'engine.hello') out({ id: m.id, result: { engineVersion: 'fake', protocolVersion: 1${caps ? `, capabilities: ${JSON.stringify(caps)}` : ''} } });
  else if (m.method === 'ask') { ${onAsk} }
  else if (m.method === 'takeover') { ${onTakeover} }
  else if (m.method === 'shutdown') { out({ id: m.id, result: {} }); process.exit(0); }
});`);
}

const ANSWER = "out({ id: m.id, result: { status: 'answered', answer: { choice: 1, label: 'Pro' }, via: 'page', durationS: 3, sessionId: 's1' } });";
const open: Unstuck[] = [];
const make = (engine: string, o: ConstructorParameters<typeof Unstuck>[0] = {}) => {
  const u = new Unstuck({ enginePath: engine, ...o });
  open.push(u);
  return u;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((u) => u.close()));
  vi.restoreAllMocks();
});

describe('Unstuck.ask (binary)', () => {
  it('returns the answer from the engine and sends the params as given', async () => {
    const engine = askEngine(['ask'], `out({ id: m.id, result: { status: 'answered', answer: { text: JSON.stringify(m.params) }, durationS: 3, sessionId: 's1' } });`);
    const r = await make(engine).ask('Which plan?', { choices: ['Free', 'Pro'], private: false, details: 'd', timeoutS: 60, allowText: true });
    expect(r).toMatchObject({ status: 'answered', sessionId: 's1' });
    expect(JSON.parse(r.answer!.text!)).toEqual({ question: 'Which plan?', choices: ['Free', 'Pro'], private: false, details: 'd', timeoutS: 60, allowText: true });
    const bare = await make(engine).ask('Name?');
    expect(JSON.parse(bare.answer!.text!)).toEqual({ question: 'Name?' });
  });

  it('on an engine without the ask capability throws engine_too_old, before any ask request', async () => {
    for (const caps of [null, ['guard']]) {
      const u = make(askEngine(caps, "out({ id: m.id, result: { status: 'answered', durationS: 0, sessionId: 's' } });"));
      const e = await u.ask('Q?').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(UnstuckEngineError);
      expect((e as Error).message).toBe("this engine can't ask questions (needs @velmlabs/unstuck-engine 0.4.0 or later)");
      expect(e).toMatchObject({ code: 'engine_too_old' });
    }
  });

  it('rejects out-of-range params with UnstuckConfigError (the checkAsk message), without starting an engine', async () => {
    const u = make('/nonexistent/engine');
    const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    await expect(u.ask('Q?', { choices: seven })).rejects.toBeInstanceOf(UnstuckConfigError);
    await expect(u.ask('Q?', { choices: seven })).rejects.toThrow('choices must be 2-6 labels of at most 80 characters');
    await expect(u.ask('', {})).rejects.toThrow('question must be 1-300 characters');
    await expect(u.ask('Q?', { allowText: false })).rejects.toThrow('a question needs choices or allowText');
  });

  it('maps an engine bad_params and config_error to UnstuckConfigError, other errors pass through', async () => {
    const bad = make(askEngine(['ask'], "out({ id: m.id, error: { code: 'bad_params', message: 'private must be true or false' } });"));
    const e = await bad.ask('Q?').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UnstuckConfigError);
    expect((e as Error).message).toBe('private must be true or false');
    const cfg = make(askEngine(['ask'], "out({ id: m.id, error: { code: 'config_error', message: 'nope' } });"));
    await expect(cfg.ask('Q?')).rejects.toBeInstanceOf(UnstuckConfigError);
    const other = make(askEngine(['ask'], "out({ id: m.id, error: { code: 'boom', message: 'x' } });"));
    await expect(other.ask('Q?')).rejects.toMatchObject({ code: 'boom' });
  });

  it('ask.link goes to the per-call onLink, else the option onLink, else the default printer (stderr)', async () => {
    const link = "note('ask.link', { sessionId: 's1', url: 'https://v.example/s/1#t=secret', reason: m.params.question, expiresAt: 5, code: '123456' });";
    const engine = askEngine(['ask'], `${link} ${ANSWER}`);
    const mine: unknown[] = [];
    const u = make(engine, { onLink: (l) => mine.push(['option', l]) });
    await u.ask('Q1?', { onLink: (l) => mine.push(['call', l]) });
    await u.ask('Q2?');
    expect(mine).toEqual([
      ['call', { url: 'https://v.example/s/1#t=secret', reason: 'Q1?', sessionId: 's1', expiresAt: 5, code: '123456' }],
      ['option', { url: 'https://v.example/s/1#t=secret', reason: 'Q2?', sessionId: 's1', expiresAt: 5, code: '123456' }],
    ]);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await make(engine).ask('Q3?');
    expect(err).toHaveBeenCalledWith('Unstuck: a human is needed (Q3?) → https://v.example/s/1#t=secret\n');
    expect(err.mock.calls.join('')).not.toContain('123456');
  });

  it('a throwing onLink is reported without the link and the ask goes on', async () => {
    const engine = askEngine(['ask'], `note('ask.link', { sessionId: 's1', url: 'https://v.example/s/1#t=secret', reason: 'Q?', expiresAt: 5 }); ${ANSWER}`);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await make(engine).ask('Q?', {
      onLink: () => {
        throw new Error('boom https://v.example/s/1#t=secret');
      },
    });
    expect(r.status).toBe('answered');
    expect(String(err.mock.calls[0]![0])).not.toContain('secret');
  });

  it('two asks in flight each get their own link', async () => {
    const engine = askEngine(
      ['ask'],
      `setTimeout(() => { note('ask.link', { sessionId: 'id-' + m.params.question, url: 'https://v.example/' + m.params.question, reason: m.params.question, expiresAt: 5 }); ${ANSWER} }, m.params.question === 'A' ? 80 : 10);`,
    );
    const u = make(engine);
    const seen: string[] = [];
    const [a, b] = await Promise.all([u.ask('A', { onLink: (l) => seen.push(`a:${l.url}`) }), u.ask('B', { onLink: (l) => seen.push(`b:${l.url}`) })]);
    expect([a.status, b.status]).toEqual(['answered', 'answered']);
    expect(seen.sort()).toEqual(['a:https://v.example/A', 'b:https://v.example/B']);
  });

  it('a link for an ask nobody is waiting for is ignored; an engine that dies fails the ask with UnstuckEngineError', async () => {
    const stray = askEngine(['ask'], `note('ask.link', { sessionId: 'x', url: 'https://v.example/x', reason: 'other', expiresAt: 5 }); ${ANSWER}`);
    expect((await make(stray, { onLink: () => {} }).ask('Q?')).status).toBe('answered');
    const dies = askEngine(['ask'], 'process.exit(3);');
    await expect(make(dies).ask('Q?')).rejects.toBeInstanceOf(UnstuckEngineError);
  });

  it('agentName reaches the engine process as UNSTUCK_AGENT_NAME (takeover too)', async () => {
    const engine = askEngine(['ask'], "out({ id: m.id, result: { status: 'answered', answer: { text: process.env.UNSTUCK_AGENT_NAME ?? 'unset' }, durationS: 0, sessionId: 's' } });");
    const u = make(engine, { agentName: 'Ava' });
    expect((await u.ask('Q?')).answer!.text).toBe('Ava');
    expect((await make(engine).ask('Q?')).answer!.text).toBe(process.env.UNSTUCK_AGENT_NAME ?? 'unset');
  });

  it('takeover forwards mode, kind and timeoutS into TakeoverParams (only when given)', async () => {
    const engine = askEngine(['ask'], ANSWER);
    const browser = await launch();
    const page = await browser.newPage();
    const u = make(engine, { onLink: () => {} });
    const sent = async (o: object) => JSON.parse((await u.takeover(page, { reason: 'x', ...o })).detail!);
    expect(await sent({ mode: 'approval', kind: 'approval', timeoutS: 120 })).toMatchObject({ mode: 'approval', kind: 'approval', timeoutS: 120 });
    const plain = await sent({});
    expect(plain).not.toHaveProperty('mode');
    expect(plain).not.toHaveProperty('kind');
    await page.close();
    await browser.close();
  });
});
