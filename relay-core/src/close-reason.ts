const enc = new TextEncoder();
/** WebSocket close reasons are at most 123 UTF-8 bytes; a longer one makes close() throw. */
export const MAX_CLOSE_REASON_BYTES = 123;

/** The close reason for a refused agent, `{"error":"…"}`, with the error shortened (by whole code points) to fit. */
export function refusalReason(error: string): string {
  const chars = Array.from(error);
  let r = JSON.stringify({ error });
  while (enc.encode(r).length > MAX_CLOSE_REASON_BYTES) {
    chars.pop();
    r = JSON.stringify({ error: chars.join('') });
  }
  return r;
}
