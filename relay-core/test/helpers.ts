import type { RelaySocket } from '../src/session';

export class FakeSocket implements RelaySocket {
  sent: (string | Uint8Array)[] = [];
  closed: { code: number; reason?: string } | null = null;
  bufferedAmount = 0;
  send(d: string | Uint8Array) {
    if (!this.closed) this.sent.push(d);
  }
  close(code: number, reason?: string) {
    this.closed ??= { code, reason };
  }
  json() {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d));
  }
  bytes() {
    return this.sent.filter((d): d is Uint8Array => d instanceof Uint8Array);
  }
}
