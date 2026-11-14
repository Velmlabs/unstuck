import { describe, it, expect, vi } from 'vitest';
import { settle } from './settle';

describe('settle', () => {
  it('waits for WebCrypto work still in flight, however long it takes', async () => {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt']);
    let done = false;
    // ~64 MB takes far longer than a fixed few-millisecond wait, so only waiting for the work itself passes.
    void crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, new Uint8Array(64 * 1024 * 1024)).then(() => (done = true));
    await settle();
    expect(done).toBe(true);
  });

  it('waits for a chain of crypto steps, each started after the last one finished', async () => {
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt']);
    let steps = 0;
    const step = () => crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, new Uint8Array(4 * 1024 * 1024)).then(() => steps++);
    void step().then(step).then(step);
    await settle();
    expect(steps).toBe(3);
  });

  it('works under fake timers without moving fake time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      let fired = false;
      setTimeout(() => (fired = true), 1);
      const now = Date.now();
      await settle();
      expect(fired).toBe(false);
      expect(Date.now()).toBe(now);
    } finally {
      vi.useRealTimers();
    }
  });
});
