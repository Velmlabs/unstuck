import type { CdpClient } from './cdp';

export interface Capabilities {
  screencast: boolean;
  insertText: boolean;
  input: boolean;
}

export const PROBE_TIMEOUT_MS = 3000;

async function supported(call: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call().then(() => true),
      new Promise<boolean>((r) => (timer = setTimeout(() => r(false), timeoutMs))),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Checks what this browser supports, with no visible effect on the page (spec §4.4). */
export async function probeCapabilities(cdp: CdpClient, opts: { timeoutMs?: number } = {}): Promise<Capabilities> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const screencast = await supported(async () => {
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 1, maxHeight: 1 });
    await cdp.send('Page.stopScreencast');
  }, timeoutMs);
  const insertText = await supported(() => cdp.send('Input.insertText', { text: '' }), timeoutMs);
  const input = await supported(() => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 }), timeoutMs);
  return { screencast, insertText, input };
}
