# @unstuck/relay

Self-hosted Unstuck relay for Node and Docker (AGPL-3.0). Your agents and the humans who help them both connect *out* to it; it pairs them and forwards bytes it can't read, because everything is end-to-end encrypted between the agent's engine and the human's browser.

## Run with Docker

```bash
docker build -f relay-node/Dockerfile -t unstuck-relay .
docker run -p 8787:8787 -e UNSTUCK_AGENT_KEYS=change-me unstuck-relay
```

Put it behind HTTPS (any reverse proxy), then point agents at it:

```bash
UNSTUCK_RELAY_URL=wss://relay.example.com UNSTUCK_AGENT_KEY=change-me python my_agent.py
```

## Environment

| Variable | Meaning |
|---|---|
| `UNSTUCK_AGENT_KEYS` | Comma-separated keys allowed to register takeovers. Required unless open mode. |
| `UNSTUCK_RELAY_OPEN=1` | Accept any agent. **Local testing only**; it warns at start and on every agent connection. |
| `PORT` | Port (default 8787), or `--port`. `--host` sets the bind address (default `0.0.0.0`). |
| `UNSTUCK_TRUST_PROXY=1` | Take client IPs from `X-Forwarded-For`. Only behind a proxy you control. |

## What it keeps

Nothing on disk. Each takeover lives in memory for at most its expiry (capped at 1 hour) plus a 60-second grace; a sweep every 60 seconds removes anything older. Usage events (`session_opened`, `takeover_opened`, `session_closed`, …) are printed as JSON lines on stderr.

## Embedding

```ts
import { createNodeRelay } from '@unstuck/relay';
import { createKeyAuthorizer } from '@unstuck/relay-core';

await createNodeRelay({ port: 8787, viewerDir, authorize: createKeyAuthorizer({ keys: ['…'] }), onEvent: console.log });
```
