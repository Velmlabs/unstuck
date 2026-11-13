/** Decides whether an agent may register a session, and on whose account (relay spec §5.5). */
export type Authorize = (
  agentKey: string | null,
  ctx: { sessionId: string; ip: string },
) => Promise<{ ok: true; account: string } | { ok: false; status: 401 | 402 | 403 | 429; error: string }>;

export type RelayEvent =
  | { name: 'session_opened'; sessionId: string; account: string; at: number }
  | { name: 'viewer_connected'; sessionId: string; account: string; at: number }
  /** Billable: at most once per session, when a human first received a screen frame. */
  | { name: 'takeover_opened'; sessionId: string; account: string; at: number }
  | { name: 'agent_event'; sessionId: string; account: string; event: string; at: number }
  | {
      name: 'session_closed';
      sessionId: string;
      account: string;
      at: number;
      durationMs: number;
      bytesToViewers: number;
      bytesToAgent: number;
      viewers: number;
    };

export type OnEvent = (e: RelayEvent) => void | Promise<void>;
