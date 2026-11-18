// What every session kind does to hand out its link and keep it open: publish, seal viewer connections, sign the
// token, and end the session when a viewer who left can never come back.
import { RESUME_WINDOW_MS, b64urlEncode, importE2eKey, newE2eKey, type SessionMode } from '@velmlabs/unstuck-protocol';
import type { Transport } from '../transport';
import type { ViewerGate } from './gate';
import { sealConnection } from './sealed';
import { signToken } from './tokens';

export interface PublishLinkOptions {
  transport: Transport;
  key: CryptoKey;
  sessionId: string;
  expiresAt: number;
  mode: SessionMode;
  /** Admits the (sealed) viewer connections. */
  gate: Pick<ViewerGate, 'onConnection'>;
  isEnded(): boolean;
  /** The transport has published the session: it must be unpublished when the session finishes. */
  onPublished(): void;
  /** The path to humans went down or came back (see createResumeWatch). */
  onStatus(s: 'up' | 'down'): void;
}

/** `url`: the link to hand out. `failed`: why publishing failed. `ended`: the session ended meanwhile (no link). */
export type PublishOutcome = { url: string } | { failed: string } | { ended: true };

/**
 * Publishes the session and returns its link `<baseUrl>#t=<token>&k=<e2e key>` (plus `&m=q` or `&m=a` for a question or
 * an approval). Viewer connections are sealed with the link's key before they reach the gate. Never rejects. A session that ended before the transport answered is
 * unpublished again here (its finish ran before `onPublished`).
 */
export async function publishLink(o: PublishLinkOptions): Promise<PublishOutcome> {
  try {
    const rawE2e = newE2eKey();
    const e2eKey = await importE2eKey(rawE2e);
    const { baseUrl } = await o.transport.publish(o.sessionId, { expiresAt: o.expiresAt, mode: o.mode });
    o.onPublished();
    if (o.isEnded()) {
      void o.transport.unpublish(o.sessionId).catch(() => {});
      return { ended: true };
    }
    o.transport.onConnection(o.sessionId, (conn) => o.gate.onConnection(sealConnection(conn, e2eKey, o.sessionId)));
    o.transport.onStatus?.(o.sessionId, o.onStatus);
    const token = await signToken(o.key, o.sessionId, o.expiresAt);
    // `m`: a hint for the viewer's start page (q: a question, a: a sign-in approval); not a secret, older viewers ignore it.
    const hint = o.mode === 'question' ? '&m=q' : o.mode === 'approval' ? '&m=a' : '';
    return o.isEnded() ? { ended: true } : { url: `${baseUrl}#t=${token}&k=${b64urlEncode(rawE2e)}${hint}` };
  } catch (e) {
    // A relay says why it refused (relay_unauthorized, relay_quota_exceeded, ...): pass that through.
    const detail = (e as { detail?: unknown }).detail;
    return { failed: typeof detail === 'string' ? detail : `publish_error: ${(e as Error).message}` };
  }
}

export interface ResumeWatch {
  /** A viewer is attached: no deadline. */
  attached(): void;
  /** The holder left: unless the path to humans is down, `onLapse` runs once the resume window has passed. */
  left(): void;
  /** The transport's up/down reports: the deadline is paused while down and restarts in full when it comes back. */
  onStatus(s: 'up' | 'down'): void;
  stop(): void;
}

/**
 * The viewer-left deadline: if the holder leaves and nobody resumes in time, nobody can ever rejoin (the token is
 * spent), so `onLapse` frees the agent.
 */
export function createResumeWatch(o: { gate: Pick<ViewerGate, 'renewResumeWindow'>; isEnded(): boolean; onLapse(): void }): ResumeWatch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let down = false;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const start = () => {
    stop();
    timer = setTimeout(o.onLapse, RESUME_WINDOW_MS);
  };
  return {
    attached: stop,
    left() {
      if (!down) start();
    },
    onStatus(s) {
      if (o.isEnded()) return;
      down = s === 'down';
      if (down) stop();
      else if (o.gate.renewResumeWindow()) start(); // the resume window restarts in full once humans can reach us again
    },
    stop,
  };
}
