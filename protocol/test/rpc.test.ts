import { describe, it, expect, vi } from 'vitest';
import { createRpcPeer, type RpcPeer } from '../src/rpc';

function pair(): [RpcPeer, RpcPeer] {
  let a!: RpcPeer;
  let b!: RpcPeer;
  a = createRpcPeer((line) => queueMicrotask(() => b.receive(line)));
  b = createRpcPeer((line) => queueMicrotask(() => a.receive(line)));
  return [a, b];
}

describe('createRpcPeer', () => {
  it('resolves a request with the handler result', async () => {
    const [a, b] = pair();
    b.handle('x', (p) => (p as { n: number }).n + 1);
    await expect(a.request('x', { n: 1 })).resolves.toBe(2);
  });

  it('supports async handlers', async () => {
    const [a, b] = pair();
    b.handle('x', async () => 'later');
    await expect(a.request('x')).resolves.toBe('later');
  });

  it('rejects unknown methods with code unknown_method', async () => {
    const [a] = pair();
    await expect(a.request('nope')).rejects.toMatchObject({ code: 'unknown_method' });
  });

  it('rejects with code handler_error when the handler throws', async () => {
    const [a, b] = pair();
    b.handle('x', () => {
      throw new Error('boom');
    });
    await expect(a.request('x')).rejects.toMatchObject({ code: 'handler_error', message: 'boom' });
  });

  it('passes through a handler error that carries its own code', async () => {
    const [a, b] = pair();
    b.handle('x', () => {
      throw Object.assign(new Error('old protocol'), { code: 'protocol_mismatch' });
    });
    await expect(a.request('x')).rejects.toMatchObject({ code: 'protocol_mismatch' });
  });

  it('delivers notifications to onNotification', async () => {
    const [a, b] = pair();
    const got = vi.fn();
    b.onNotification('ev', got);
    a.notify('ev', { k: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toHaveBeenCalledWith({ k: 1 });
  });

  it('ignores notifications nobody listens to', async () => {
    const [a] = pair();
    expect(() => a.notify('unheard')).not.toThrow();
  });

  it('close rejects pending requests with the reason and later requests too', async () => {
    const [a, b] = pair();
    b.handle('slow', () => new Promise(() => {}));
    const pending = a.request('slow');
    a.close('gone');
    await expect(pending).rejects.toThrow('gone');
    await expect(a.request('slow')).rejects.toThrow('gone');
  });

  it('ignores malformed lines and responses to unknown ids', () => {
    const [a] = pair();
    expect(() => a.receive('not json')).not.toThrow();
    expect(() => a.receive('{"id":999,"result":1}')).not.toThrow();
    expect(() => a.receive('42')).not.toThrow();
  });

  it('writes one JSON object per line', () => {
    const lines: string[] = [];
    const p = createRpcPeer((l) => lines.push(l));
    p.notify('a', { x: 1 });
    expect(lines).toEqual(['{"method":"a","params":{"x":1}}']);
  });
});

describe('protocol minor 1', () => {
  it('keeps major 1, adds minor 1 and the guard method names', async () => {
    const t = await import('../src/rpc-types');
    expect(t.PROTOCOL_VERSION).toBe(1);
    expect(t.PROTOCOL_MINOR).toBe(1);
    expect(t.Methods).toMatchObject({
      guardOpen: 'guard.open',
      guardBefore: 'guard.before',
      guardAfter: 'guard.after',
      guardCheck: 'guard.check',
      guardAskHuman: 'guard.askHuman',
      guardSession: 'guard.getSession',
      guardRemember: 'guard.rememberSite',
      guardForget: 'guard.forgetSite',
      guardForgetAll: 'guard.forgetAll',
      guardClose: 'guard.close',
      paintCheck: 'browser.paintCheck',
      pageCreate: 'page.create',
      pageClose: 'page.close',
      guardRescue: 'guard.rescue',
    });
  });
});
