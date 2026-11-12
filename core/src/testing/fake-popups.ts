import type { CdpClient } from '../cdp';
import type { PopupSource } from '../session/takeover';

/** A popup source tests can fire. */
export class FakePopups implements PopupSource {
  private readonly listeners = new Set<(popup: CdpClient) => void>();
  onPopup(cb: (popup: CdpClient) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
  open(popup: CdpClient): void {
    for (const cb of [...this.listeners]) cb(popup);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}
