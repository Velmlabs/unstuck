import { describe, it, expect } from 'vitest';
import { main } from '../src/cli';

const io = () => {
  const out: string[] = [];
  return { out, stderr: { write: (s: string) => void out.push(s) } };
};

describe('unstuck-relay CLI', () => {
  it('refuses to start without keys or open mode, naming both variables', async () => {
    const o = io();
    expect(await main([], {}, o)).toBe(2);
    expect(o.out.join('')).toMatch(/UNSTUCK_AGENT_KEYS.*UNSTUCK_RELAY_OPEN|UNSTUCK_RELAY_OPEN.*UNSTUCK_AGENT_KEYS/s);
  });

  it('open mode warns at start and on every agent connection', async () => {
    const o = io();
    const r = await main(['--port', '0', '--host', '127.0.0.1'], { UNSTUCK_RELAY_OPEN: '1' }, o);
    if (typeof r === 'number') throw new Error('did not start');
    expect(o.out.join('')).toContain('relay is OPEN: anyone can register sessions');
    const before = o.out.length;
    const ws = new WebSocket(`ws://127.0.0.1:${r.port}/agent/SESSIONOPEN_0000000000`, ['unstuck-relay.1']);
    await new Promise((res) => (ws.onopen = res));
    ws.close();
    expect(o.out.slice(before).join('')).toContain('relay is OPEN');
    await r.close();
  });

  it('starts with keys from UNSTUCK_AGENT_KEYS and PORT, and rejects bad flags', async () => {
    const o = io();
    const r = await main(['--host', '127.0.0.1'], { UNSTUCK_AGENT_KEYS: 'a, b', PORT: '0' }, o);
    if (typeof r === 'number') throw new Error('did not start');
    expect(o.out.join('')).toContain(`listening on http://127.0.0.1:${r.port}`);
    await r.close();
    expect(await main(['--nope'], { UNSTUCK_RELAY_OPEN: '1' }, io())).toBe(2);
    expect(await main(['--port', 'x'], { UNSTUCK_RELAY_OPEN: '1' }, io())).toBe(2);
  });

  it('binds 0.0.0.0 by default', async () => {
    const o = io();
    const r = await main(['--port', '0'], { UNSTUCK_AGENT_KEYS: 'k' }, o);
    if (typeof r === 'number') throw new Error('did not start');
    expect(o.out.join('')).toContain('listening on http://0.0.0.0:');
    await r.close();
  });

  it('UNSTUCK_TRUST_PROXY takes a hop count; UNSTUCK_HSTS=1 turns on HSTS', async () => {
    const o = io();
    const r = await main(['--port', '0', '--host', '127.0.0.1'], { UNSTUCK_AGENT_KEYS: 'k', UNSTUCK_TRUST_PROXY: '2', UNSTUCK_HSTS: '1' }, o);
    if (typeof r === 'number') throw new Error('did not start');
    expect((await fetch(`http://127.0.0.1:${r.port}/healthz`)).headers.get('strict-transport-security')).toBe('max-age=31536000');
    await r.close();
    expect(await main(['--port', '0'], { UNSTUCK_AGENT_KEYS: 'k', UNSTUCK_TRUST_PROXY: 'yes' }, io())).toBe(2);
  });
});
