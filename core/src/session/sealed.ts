import { isJsonPlaintext, newConnNonce, openMsg, sealMsg } from '@velmlabs/unstuck-protocol';
import type { ViewerConnection } from '../transport';

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Wraps a viewer connection so the session works in plaintext while the wire carries only end-to-end sealed
 * messages (relay spec §5.4). The engine opens with a sealed challenge carrying a fresh connection nonce; every
 * message after that is bound to the nonce and to a sequence number that must increase, so a relay can't replay
 * a message on another connection or twice on this one. Order is kept in both directions.
 */
export function sealConnection(conn: ViewerConnection, key: CryptoKey, sessionId: string): ViewerConnection {
  const nonce = newConnNonce();
  let outSeq = 0;
  let lastIn = 0;
  let outChain: Promise<void> = Promise.resolve();
  let inChain: Promise<void> = Promise.resolve();
  let pendingBytes = 0;
  let dead = false;
  /** close() was called: no new sends, queued ones still flush. */
  let closing = false;

  const queue = (plain: Uint8Array, challenge = false) => {
    pendingBytes += plain.length;
    outChain = outChain
      .then(async () => {
        const sealed = challenge ? await sealMsg(key, sessionId, 'e2v', '', 0, plain) : await sealMsg(key, sessionId, 'e2v', nonce, ++outSeq, plain);
        conn.send(sealed); // the underlying connection drops sends after it closes
      })
      .catch(() => {}) // one failed step must not poison every later message
      .finally(() => void (pendingBytes -= plain.length));
  };
  // v: 2 — this engine echoes the viewer's random value (hello.vn) in ready, so a viewer can tell a replayed stream.
  queue(enc.encode(JSON.stringify({ t: 'challenge', n: nonce, v: 2 })), true);

  const kill = () => {
    dead = true;
    conn.close(1008, 'undecryptable');
  };

  return {
    send(data) {
      if (closing) return;
      queue(typeof data === 'string' ? enc.encode(data) : data);
    },
    get bufferedAmount() {
      return conn.bufferedAmount + pendingBytes;
    },
    onMessage(h) {
      conn.onMessage((raw) => {
        const bytes = typeof raw === 'string' ? enc.encode(raw) : raw;
        inChain = inChain
          .then(async () => {
            if (dead) return;
            const m = await openMsg(key, sessionId, 'v2e', nonce, bytes);
            if (dead) return;
            // Not ours, tampered, replayed, or one skipped: a relay never drops viewer messages (it closes the viewer instead),
            // so a gap means a message was withheld on purpose (e.g. one keystroke).
            if (!m || m.seq !== lastIn + 1) return kill();
            lastIn = m.seq;
            h(isJsonPlaintext(m.plain) ? dec.decode(m.plain) : m.plain);
          })
          .catch(() => {});
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
