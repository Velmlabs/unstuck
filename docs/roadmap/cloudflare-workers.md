# Roadmap: official Cloudflare Workers support

**Status:** Phase 1 shipped in 0.2.0; Phases 2–3 open · **Owner:** Velm Labs

Unstuck runs *around* Cloudflare Workers (the relay and the hosted viewer are Workers) and, since 0.2.0, *inside* one.
An agent written as a Worker (with the Agents SDK or Browser Rendering) can call `takeover()`. This document was the
plan; it is kept for the design reasoning and for the phases that are still open.

## Where we are

| Piece | Status |
|---|---|
| Relay on Workers (`relay-cloudflare/`) | ✅ Shipped. Unstuck Cloud runs on it; self-hosters can deploy it |
| Viewer on Workers (`view.unstuck.sh`) | ✅ Shipped |
| Engine core without Node (`core/`, `protocol/`, `viewer/`) | ✅ Web-standard APIs only, enforced in CI by `scripts/check-runtime-agnostic.mjs` |
| Relay client (`core/src/relay-transport.ts`) | ✅ Portable: the global `WebSocket` |
| End-to-end encryption and alert sealing (`protocol/`) | ✅ Portable: Web Crypto |
| Cloudflare Browser Rendering with Unstuck | ✅ Proven in [`docs/spikes/cloudflare-browser-rendering.md`](../spikes/cloudflare-browser-rendering.md): screencast, input, paste, cross-origin CAPTCHA iframes and popups all work |
| TypeScript SDK inside a Worker | ✅ Shipped in 0.2.0: in-process mode, picked by the package's export conditions. See [unstuck.sh/docs/cloudflare-workers](https://unstuck.sh/docs/cloudflare-workers/) |
| Cloud phone alerts from a Worker | ✅ Shipped in 0.2.0: the alert code moved into `core/`, with `alerts: 'required'` |
| Workflows | ✅ Works, per a user report: set an explicit `step.do` timeout and `retries: { limit: 0 }`. No automated test yet |

The MVP design already planned this as the SDK's **in-process mode** (design spec §4.3: "binary mode under Node,
in-process mode elsewhere"; "in-process mode on Workers has no embedded server, so it requires a relay"). It was
deferred so Node, Python and MCP could ship first.

## Goals

- `takeover(page, { reason })` works in a Cloudflare Worker with the same API and results as on Node.
- Pages from Cloudflare Browser Rendering (`@cloudflare/puppeteer`) can be handed to a person.
- Takeovers can wait for a person for minutes, as they do elsewhere (default 10 minutes, up to an hour).
- Phone alerts work from Workers with an Unstuck Cloud key.
- Works with Unstuck Cloud and with a self-hosted relay, including a relay on the same Cloudflare account.
- Covered by CI like every other runtime.

## Non-goals

- An embedded viewer server inside a Worker. Workers always use a relay (Cloud or self-hosted).
- Python on Workers. Python Workers can't drive a browser over CDP today; revisit if that changes.
- New takeover features. This is about where Unstuck runs, not what it does.

## Design

### 1. In-process mode in the TypeScript SDK

`new Unstuck()` picks its mode from the runtime:

- **Binary mode** (today): Node, where the engine runs as a separate process.
- **In-process mode** (new): Workers, Deno, Bun or when forced with an option. The SDK calls `createEngine()` from
  `@velmlabs/unstuck-core` directly, with `createRelayTransport()` from the same package.

Detection: `navigator.userAgent === 'Cloudflare-Workers'`, or no `process.versions.node`, or an explicit
`new Unstuck({ mode: 'in-process' })`. The package's `exports` gets a `workerd` condition (plus `worker` and `deno`)
pointing at an entry that never imports Node built-ins, so bundlers never pull in `node:child_process`.

Configuration in a Worker comes from bindings, not `process.env`:

```ts
const unstuck = new Unstuck({ apiKey: env.UNSTUCK_API_KEY });                       // Unstuck Cloud
const unstuck = new Unstuck({ relay: env.UNSTUCK_RELAY_URL, agentKey: env.UNSTUCK_AGENT_KEY }); // self-hosted
```

### 2. Pages from Browser Rendering

`@cloudflare/puppeteer` pages expose `page.createCDPSession()`, which is what `sdk-ts/src/attach.ts` already uses for
Puppeteer. The work is to confirm the session object matches `CdpSessionLike`, adapt if not, and cover it with a test.

```ts
import puppeteer from '@cloudflare/puppeteer';
import { Unstuck } from '@velmlabs/unstuck';

const browser = await puppeteer.launch(env.BROWSER);
const page = await browser.newPage();
await page.goto('https://portal.example.com/login');
const result = await new Unstuck({ apiKey: env.UNSTUCK_API_KEY }).takeover(page, { reason: 'Log in with your 2FA code' });
```

### 3. Waiting minutes for a person (the main design question)

A takeover keeps a WebSocket to the relay and a CDP session to the browser open while a person works, which can be
many minutes. A plain `fetch` handler is the wrong home for that.

| Option | How | For | Against |
|---|---|---|---|
| **A. Durable Object** (recommended) | The agent runs the takeover inside a Durable Object, which can hold sockets and stay alive while they're open | Long-lived, one object per task; the Cloudflare Agents SDK is built on Durable Objects | Developers must structure the agent as a DO (Agents SDK users already do) |
| B. Workflows | A Workflow step starts the takeover and waits for it | Durable steps and retries | A step must keep its connections open for the whole wait; needs checking against Workflows' limits |
| C. Plain Worker request | `ctx.waitUntil()` around the takeover | Simplest | Not reliable for waits of several minutes |

Proposal: support **A** officially, document **B** once tested, and have the SDK refuse to start a takeover from a
plain request handler with a clear error that points at the docs.

### 4. Phone alerts

Alert sealing is already portable (`sealAlert` in `protocol/`, Web Crypto). The engine-only part
(`engine/src/cloud-alerts.ts`: fetch the paired phones, seal the link to each, post it to Cloud) moves into `core/` (or
`sdk-ts`) so in-process mode uses the same code. Only for Unstuck Cloud keys, as today.

### 5. Same-account relay

A Worker agent and a self-hosted `relay-cloudflare` on the same account can talk over a **service binding** instead of
the public internet. Nice-to-have for Phase 2, not needed to ship.

## Phases

### Phase 1: Workers agents (shipped in 0.2.0)

1. In-process mode in `sdk-ts`: runtime detection, `workerd` export condition, `createEngine()` + relay transport.
2. Browser Rendering pages via `@cloudflare/puppeteer` (adapter and test).
3. Durable Object support for long waits; a clear error from plain request handlers.
4. Phone alerts from in-process mode (move the Cloud alert code to a shared package).
5. CI: an end-to-end test under `wrangler dev` (an agent in a DO, a person in Playwright, a local `relay-cloudflare`),
   alongside the Node, Python and MCP tests. Keep the 90% coverage bar.
6. Release 0.2.0 (minor bump: a new mode, same API).

### Phase 2: docs and examples

- Docs page `unstuck.sh/docs/cloudflare-workers/` (shipped with 0.2.0) and `examples/cloudflare-worker/` (deployable,
  with `wrangler.toml`; not yet).
- An Agents SDK example: an agent that hands a step to a person mid-task and carries on.
- A "Cloudflare Workers" section in the agent skill (`plugins/unstuck/skills/unstuck/SKILL.md`): shipped with 0.2.0.
- Optional: service-binding transport for a same-account relay.

### Phase 3: live demo on unstuck.sh

- "Try it on your phone": a visitor clicks **Try it**, a Worker opens a fixture CAPTCHA page in Browser Rendering,
  starts a takeover and shows the link as a QR code; the visitor solves it on their phone and sees the agent carry on.
- Guardrails: per-IP rate limits, a 2-minute timeout, a cap on concurrent demo browsers, fixture pages only (no
  arbitrary URLs), and no Unstuck account needed.
- Lives in Unstuck Cloud (private repo), built on the Phase 1 open-source code.

## Testing

- Unit: runtime detection and mode selection; the `workerd` entry never imports Node built-ins (extend
  `check-runtime-agnostic.mjs` to `sdk-ts`'s in-process entry).
- Integration: `@cloudflare/vitest-pool-workers` for the in-process engine against a fake CDP and fake relay.
- End to end: `wrangler dev` with a local Browser Rendering session where available; otherwise Chromium over CDP
  standing in for it, plus a manual check against real Browser Rendering before each release.

## Risks and open questions

- **Long-held connections in Workers:** confirm Durable Object behaviour while a CDP session and a relay socket are
  both open for up to an hour (hibernation can't apply while the CDP socket is active).
- **Browser Rendering limits:** per-account concurrent browsers and browser time. They matter most for the public demo.
- **CDP coverage in `@cloudflare/puppeteer`:** the spike confirmed what Unstuck uses today; re-check `Fetch.*` (page
  lock) and `Target.*` (popups), which came later.
- **Bundle size:** the in-process entry must stay small enough for Workers' script size limits (core + protocol only).
- **Open question:** should in-process mode also be the default on Bun and Deno, or opt-in there at first?

## Why it matters

- **Fair:** Workers support lives in the open-source SDK, like every other runtime.
- **Sustainable:** a Worker agent has no local machine, so it always uses a relay. Unstuck Cloud is the easiest one,
  with alerts included, so Workers users are natural Cloud customers. Self-hosters can use `relay-cloudflare` on their
  own account.
- **Growth:** the live demo lets anyone try Unstuck in thirty seconds, with nothing to install.
