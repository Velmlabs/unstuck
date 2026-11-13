import { isJsonPlaintext, open, seal } from '@unstuck/protocol';
import type { ViewerConnection } from '../transport';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Wraps a viewer connection so the session works in plaintext while the wire carries only
 * end-to-end sealed messages (relay spec §5.4). Order is kept in both directions.
 */
export function sealConnection(conn: ViewerConnection, key: CryptoKey, sessionId: string): ViewerConnection {
  let outChain: Promise<void> = Promise.resolve();
  let inChain: Promise<void> = Promise.resolve();
  let pendingBytes = 0;
  let dead = false;
  /** close() was called: no new sends, queued ones still flush. */
  let closing = false;

  return {
    send(data) {
      if (closing) return;
      const plain = typeof data === 'string' ? enc.encode(data) : data;
      pendingBytes += plain.length;
      outChain = outChain.then(async () => {
        const sealed = await seal(key, sessionId, 'e2v', plain);
        pendingBytes -= plain.length;
        conn.send(sealed); // the underlying connection drops sends after it closes
      });
    },
    get bufferedAmount() {
      return conn.bufferedAmount + pendingBytes;
    },
    onMessage(h) {
      conn.onMessage((raw) => {
        const bytes = typeof raw === 'string' ? enc.encode(raw) : raw;
        inChain = inChain.then(async () => {
          if (dead) return;
          const plain = await open(key, sessionId, 'v2e', bytes);
          if (dead) return;
          if (!plain) {
            dead = true;
            conn.close(1008, 'undecryptable');
            return;
          }
          h(isJsonPlaintext(plain) ? dec.decode(plain) : plain);
        });
      });
    },
    onClose(h) {
      conn.onClose(() => {
        dead = true;
        closing = true;
        h();
      });
    },
    close(code, reason) {
      if (closing) return;
      closing = true;
      // Stop reading now, but let messages already queued (e.g. an error reply) go out first.
      dead = true;
      outChain = outChain.then(() => conn.close(code, reason));
    },
  };
}
