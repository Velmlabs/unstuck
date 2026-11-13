# Unstuck

**Human takeover for AI browser agents.** When your agent gets stuck on a CAPTCHA, a login wall, a 2FA prompt or any page that needs a person, Unstuck pauses the agent, sends the right human a link, lets them take over the live browser from any device, and hands control back.

> Work in progress. See the [MVP design spec](docs/superpowers/specs/2026-11-12-unstuck-mvp-design.md) and [Plan 1](docs/superpowers/plans/2026-11-12-unstuck-plan-1-foundation.md).

![The Unstuck viewer on a phone: the agent's live page with Keyboard, Can't solve and Done buttons](docs/screenshots/viewer-live-iphone13.png)

## Quickstart (5 minutes, no infrastructure)

Requirements: Node 22, pnpm 10, [Bun](https://bun.sh) (only to compile the engine), and Playwright for the example.

1. Build the engine binary (it embeds the viewer):

```bash
pnpm install
```

```bash
pnpm --filter @unstuck/engine build
```

2. Add one call where your agent gets stuck:

```ts
import { chromium } from 'playwright';
import { Unstuck } from 'unstuck';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://www.google.com/recaptcha/api2/demo');

const unstuck = new Unstuck({ onLink: ({ url, reason }) => console.log(`${reason}: ${url}`) });
const result = await unstuck.takeover(page, { reason: 'Please solve the CAPTCHA', timeoutS: 300 });
console.log(result.status); // 'resolved' | 'timed_out' | 'cancelled' | 'failed'
await unstuck.close();
await browser.close();
```

3. Run the bundled example and open the printed link in any browser:

```bash
cd examples/playwright-ts && UNSTUCK_ENGINE_PATH=../../engine/dist/unstuck-engine pnpm start
```

The human sees the live page, taps and types into it (a **Keyboard** button opens the phone keyboard), then taps **Done**. `takeover()` resolves and your agent continues. **Can't solve** hands it back with an optional reason.

By default the viewer is only reachable on `127.0.0.1`. To open the link from a phone, set `UNSTUCK_HOST=0.0.0.0` and `UNSTUCK_PUBLIC_URL=http://<your-lan-ip>:<port>` (the engine warns when it is reachable from your network), or wait for the relay in Plan 3.

### Python

The Python SDK has the same API, async with Playwright:

```python
from unstuck import Unstuck

async with Unstuck(on_link=lambda link: print(link.reason, link.url)) as unstuck:
    result = await unstuck.takeover(page, reason="Please solve the CAPTCHA", timeout_s=300)
print(result.status)
```

Run the bundled Python example (uses the engine built above):

```bash
cd examples/playwright-py && UNSTUCK_ENGINE_PATH=../../engine/dist/unstuck-engine uv run --project ../../sdk-py python main.py
```

### MCP (Claude Desktop, Claude Code, any MCP client)

The engine is also an MCP server with one tool, `request_human_takeover(reason, cdp_url?, target_id?, timeout_s?)`. It blocks until the human taps **Done** or **Can't solve** (or the takeover times out) and returns the outcome as JSON. The link reaches the human straight away: it's printed to stderr, sent as an MCP log message, and with `--open` it opens in this machine's browser.

Start the browser your agent drives with a DevTools port, for example:

```bash
google-chrome --remote-debugging-port=9222
```

Then add the server to your MCP client's config:

```json
{
  "mcpServers": {
    "unstuck": {
      "command": "/path/to/unstuck-engine",
      "args": ["--mcp", "--open"],
      "env": { "UNSTUCK_CDP_URL": "http://127.0.0.1:9222" }
    }
  }
}
```

### Is my browser supported?

`doctor` checks a browser in a tab of its own (live view, input, paste, cross-origin iframes, popups):

```bash
engine/dist/unstuck-engine doctor --cdp 127.0.0.1:9222
```

It ends with **FULL**, **LIMITED** (works, but for example CAPTCHA widgets in cross-origin iframes won't be visible) or **UNSUPPORTED**. Chromium is fully supported; Obscura is limited (see `docs/spikes/obscura.md`).

### Running anywhere: relays

By default the link points at a small server on the agent's own machine. Agents on servers, in CI or on Workers use a **relay** instead: the agent and the human both connect *out* to it.

| Where | Set |
|---|---|
| Your own machine | nothing |
| Unstuck Cloud | `UNSTUCK_API_KEY=uk_live_…` |
| Your own relay | `UNSTUCK_RELAY_URL=wss://relay.example.com` and `UNSTUCK_AGENT_KEY=…` |

The SDKs also take the relay as options (`new Unstuck({ relay, agentKey })`, `Unstuck(relay=..., agent_key=...)`), and on Workers, where there's no engine binary, use the engine in-process: `createEngine({ transport: createRelayTransport({ url, agentKey }) })` from `@unstuck/core`.

Run your own relay on Node or Docker (`relay-node/`) or on Cloudflare with one Durable Object per takeover (`relay-cloudflare/`).

If a relay refuses the agent, `takeover()` returns `failed` with `relay_unauthorized`, `relay_quota_exceeded`, `relay_rate_limited` or `relay_unreachable` instead of waiting for the timeout.

### Security model

- Each link carries a signed, single-use token and a fresh encryption key in the URL fragment (`#t=…&k=…`), so neither reaches any server or log. It expires with the takeover (default 10 minutes).
- **End-to-end encrypted:** screen frames, taps, keystrokes and the token travel sealed with AES-GCM between the agent's engine and the human's browser. A relay, Unstuck Cloud included, only ever sees ciphertext and sizes.
- Only one person can hold a takeover. A second person opening the link sees "already in use".
- Optional **6-digit code** (`requireCode: true`, `require_code=True`, or `UNSTUCK_REQUIRE_CODE=1` for MCP): the code comes with the link but isn't in it, so a forwarded link alone isn't enough. Five wrong codes lock the link to new people.
- The audit log (`~/.unstuck/events.jsonl`, or `UNSTUCK_LOG`) records states and input counts, never what was typed.

## Develop

```bash
pnpm test
```

Every package keeps test coverage above 90%. The end-to-end suite (`e2e/`) drives real takeovers from an iPhone-sized browser, locally and through both relays (the Cloudflare one under `wrangler dev`), and needs the engine built first.

## Licensing

- SDKs, engine, protocol, MCP server and integrations: [Apache-2.0](LICENSE-APACHE)
- Relay and viewer: [AGPL-3.0](LICENSE-AGPL)

Each package carries its own `LICENSE` file.
