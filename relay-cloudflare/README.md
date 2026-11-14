# @velmlabs/unstuck-relay-cloudflare

The Unstuck relay on Cloudflare Workers (AGPL-3.0): one Durable Object per takeover, WebSocket hibernation, and the viewer served as static assets. Everything between the agent's engine and the human's browser is end-to-end encrypted; the relay forwards bytes it can't read.

## Deploy your own

```bash
pnpm install
cd relay-cloudflare
npx wrangler secret put AGENT_KEYS      # comma-separated keys your agents will use
pnpm deploy                             # copies the viewer into ./public, then wrangler deploy
```

Point agents at it with `UNSTUCK_RELAY_URL=wss://<your-worker>.workers.dev` and `UNSTUCK_AGENT_KEY=<one of the keys>`.

- **Local:** `pnpm dev` (wrangler dev). Set `RELAY_OPEN = "1"` under `[vars]` to accept any agent while testing; never in production.
- **Rate limits:** the template binds `VIEWER_LIMIT` (30 upgrades/min per IP) and `AGENT_LIMIT` (20 registrations/min per key) through Workers Rate Limiting. Remove the `[[ratelimits]]` blocks to turn them off.
- **Housekeeping:** each Durable Object keeps only a small session record (no screen data) and an alarm. When the takeover ends, expires (at most 1 hour) or its agent stays gone for 60 seconds, it deletes its storage and alarm.
- **Limits to know:** Cloudflare caps WebSocket message size (see its Workers limits page); screen frames are JPEGs, usually well under 1 MB. Hibernatable sockets don't report buffered bytes, so slow-viewer frame dropping is left to the engine, which already sends newest-frame-only.

## Build on it

`createRelayWorker()` is the whole public API. A host can replace the key check and receive usage events:

```ts
import { createRelayWorker } from '@velmlabs/unstuck-relay-cloudflare';

const relay = createRelayWorker({
  authorize: async (key, { sessionId, ip }, env) => ({ ok: true, account: 'acct_123' }), // or { ok: false, status: 401 | 402 | 403 | 429, error }
  onEvent: async (e, env) => {
    // e.name: session_opened | viewer_connected | takeover_opened (billable, once per takeover) | agent_event | session_closed
  },
});
export default { fetch: relay.fetch };
export const RelaySessionDO = relay.RelaySessionDO;
```

A refused agent is accepted and then closed with `4000 + status` (4401, 4402, 4403, 4429), which the engine turns into a `failed` result (`relay_unauthorized`, `relay_quota_exceeded`, …).
