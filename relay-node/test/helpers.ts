import { b64urlDecode, importE2eKey, isJsonPlaintext, open, seal } from '@unstuck/protocol';

/** A minimal human's browser: connects to /ws/<id> and speaks sealed JSON with the link's key. */
export async function viewerFor(link: string, ws = (u: string) => new WebSocket(u)) {
  const u = new URL(link);
  const id = u.pathname.split('/').pop()!;
  const frag = new URLSearchParams(u.hash.slice(1));
  const key = await importE2eKey(b64urlDecode(frag.get('k')!)!);
  const sock = ws(`${u.origin.replace(/^http/, 'ws')}/ws/${id}`);
  sock.binaryType = 'arraybuffer';
  const raw: Uint8Array[] = [];
  const json: any[] = [];
  let closeCode: number | null = null;
  sock.onmessage = async (e) => {
    const b = new Uint8Array(e.data as ArrayBuffer);
    raw.push(b);
    const p = await open(key, id, 'e2v', b);
    if (p && isJsonPlaintext(p)) json.push(JSON.parse(new TextDecoder().decode(p)));
  };
  sock.onclose = (e) => (closeCode = e.code);
  await new Promise<void>((res, rej) => {
    sock.onopen = () => res();
    sock.onerror = () => rej(new Error('viewer could not connect'));
  });
  const send = async (m: object) => sock.send(await seal(key, id, 'v2e', new TextEncoder().encode(JSON.stringify(m))));
  return { sock, raw, json, send, token: frag.get('t')!, closeCode: () => closeCode };
}

export const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
