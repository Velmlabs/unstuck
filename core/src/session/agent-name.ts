/** The agent's name as one safe line: control, zero-width and bidi characters removed, trimmed, at most 40 code points. */
export const MAX_AGENT_NAME = 40;

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

/** `undefined` when nothing is left (or the value isn't a string: it may come straight from an RPC call). */
export function cleanAgentName(s: string | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  const out = [...s.replace(UNSAFE, '').trim()].slice(0, MAX_AGENT_NAME).join('').trim();
  return out || undefined;
}
