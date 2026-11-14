import { b64urlDecode, importE2eKey, isJsonPlaintext, openMsg, sealMsg } from '@velmlabs/unstuck-protocol';

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
  // Like the real viewer: the engine's sealed challenge comes first, then sequenced messages bound to its nonce.
  let nonce: string | null = null;
  let seq = 0;
  let chain: Promise<void> = Promise.resolve();
  sock.onmessage = (e) => {
    chain = chain.then(async () => {
      const d = e.data as ArrayBuffer | Blob;
      const b = new Uint8Array(typeof Blob !== 'undefined' && d instanceof Blob ? await d.arrayBuffer() : (d as ArrayBuffer));
      raw.push(b);
      if (nonce === null) {
        const c = await openMsg(key, id, 'e2v', '', b);
        if (c) nonce = JSON.parse(new TextDecoder().decode(c.plain)).n;
        return;
      }
      const m = await openMsg(key, id, 'e2v', nonce, b);
      if (m && isJsonPlaintext(m.plain)) json.push(JSON.parse(new TextDecoder().decode(m.plain)));
    });
  };
  sock.onclose = (e) => (closeCode = e.code);
  await new Promise<void>((res, rej) => {
    sock.onopen = () => res();
    sock.onerror = () => rej(new Error('viewer could not connect'));
  });
  const send = async (m: object) => {
    await waitFor(() => nonce !== null);
    sock.send(await sealMsg(key, id, 'v2e', nonce!, ++seq, new TextEncoder().encode(JSON.stringify(m))));
  };
  return { sock, raw, json, send, token: frag.get('t')!, closeCode: () => closeCode };
}

export const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
