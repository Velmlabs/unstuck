import type { CdpClient } from '../cdp';

export interface DocResponse {
  url: string;
  status: number;
  /** Header names lower-cased. */
  headers: Record<string, string>;
}

/** Keeps the latest main-frame document response (status and headers aren't visible from inside the page). */
export async function trackMainDocument(cdp: CdpClient): Promise<{ last(): DocResponse | null; stop(): void }> {
  await cdp.send('Network.enable');
  const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
  const main = tree.frameTree.frame.id;
  let last: DocResponse | null = null;
  let stopped = false;
  const off = cdp.on('Network.responseReceived', (p: { type: string; frameId?: string; response: { url: string; status: number; headers: Record<string, string> } }) => {
    if (stopped || p.type !== 'Document' || p.frameId !== main) return;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.response.headers ?? {})) headers[k.toLowerCase()] = String(v);
    last = { url: p.response.url, status: p.response.status, headers };
  });
  return {
    last: () => last,
    stop: () => {
      stopped = true;
      off();
    },
  };
}
