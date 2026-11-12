import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRpcPeer, type RpcPeer } from '../src/rpc';

type Step = Record<string, any>;
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cases', 'rpc.json');
const { cases } = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: { name: string; steps: Step[] }[] };

describe('shared RPC conformance cases (protocol/cases/rpc.json)', () => {
  it('has cases', () => expect(cases.length).toBeGreaterThan(5));

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    let a!: RpcPeer;
    let b!: RpcPeer;
    a = createRpcPeer((l) => queueMicrotask(() => b.receive(l)));
    b = createRpcPeer((l) => queueMicrotask(() => a.receive(l)));
    for (const s of c.steps) {
      if ('handle' in s) {
        b.handle(s.handle, (params) => {
          if (s.throws) throw Object.assign(new Error(s.throws.message), s.throws.code ? { code: s.throws.code } : {});
          if (s.echo) return params;
          return s.async ? Promise.resolve(s.returns) : s.returns;
        });
      } else if ('request' in s) {
        const p = a.request(s.request, s.params);
        if ('result' in s.expect) await expect(p).resolves.toEqual(s.expect.result);
        else await expect(p).rejects.toMatchObject(s.expect.error);
      } else if ('receive' in s) {
        expect(() => a.receive(s.receive)).not.toThrow();
      } else if ('close' in s) {
        a.close(s.close);
      } else throw new Error(`unknown step ${JSON.stringify(s)}`);
    }
  });
});
