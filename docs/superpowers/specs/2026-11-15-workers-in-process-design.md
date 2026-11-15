# Workers Phase 1: in-process mode — design

**Date:** 2026-11-15 · **Roadmap:** `docs/roadmap/cloudflare-workers.md` (Phase 1) · **Release:** 0.2.0 ·
**Status:** approved approach ("do all of it"), spike done (below)

## Intent

`takeover(page, { reason })` works inside a Cloudflare Worker (and Deno/Bun) with the same API and results as on Node,
so agents built on Workers, the Cloudflare Agents SDK and Browser Rendering can hand a stuck step to a person. Phases 2
(docs, examples, skill), hosted browsers and the live demo build on this.

## Goals

- Same `Unstuck` class and `takeover()` options/results in a Worker as on Node.
- Pages from `@cloudflare/puppeteer` (Browser Rendering) and anything else exposing a CDP session the SDK already
  understands.
- Relay required in a Worker: Unstuck Cloud (`apiKey`) or a self-hosted relay (`relay` + `agentKey`).
- Phone alerts with an Unstuck Cloud key, as on Node.
- Page lock, popups, field map (native typing), code mode: everything the engine does on Node.
- Tested in CI: unit, a Workers-runtime integration test, and an end-to-end takeover through `relay-cloudflare` under
  `wrangler dev`. Coverage stays above 90%.

## Non-goals

- An embedded viewer server in a Worker (no relay → no link): refuse with a clear error instead.
- Python on Workers.
- Detecting "plain request handler vs Durable Object" (not reliably possible); documented instead.

## Spike results (2026-11-15, throwaway Worker on the Velm Labs account, deleted afterwards)

| Needed | Result on Browser Rendering (`@cloudflare/puppeteer`, DO-hosted) |
|---|---|
| Page lock: `Fetch.enable` (Document, Request stage) → `Fetch.requestPaused` | ✅ off-site navigation paused and failed (`Aborted`), page stayed; same-site navigation continued |
| `Page.getFrameTree`, `Network.setBypassServiceWorker` | ✅ |
| Popups: `page.on('popup')`, `Target.getTargets` | ✅ |
| A Durable Object keeping a busy browser session for 10 minutes with **no incoming requests** | ✅ 119 of 120 heartbeats (every 5 s) over 10 minutes, finished cleanly, no error, with no request to the object during the run |

Earlier spike (`docs/spikes/cloudflare-browser-rendering.md`): screencast, input, paste, cross-origin CAPTCHA iframes
all work.

## Approaches considered

| | How | Verdict |
|---|---|---|
| **A. Same package, in-process entry** (chosen) | `@velmlabs/unstuck` gains a `workerd`/`worker`/`deno`/`bun` export condition whose entry builds the engine with `createEngine()` from `@velmlabs/unstuck-core` | One name to remember, same API (the roadmap's promise); bundlers only include what the entry imports |
| B. Separate package `@velmlabs/unstuck-workers` | A second SDK for edge runtimes | Two APIs drift; users must know which to install |
| C. Run the engine binary somewhere and talk to it over HTTP | Workers call a hosted engine | Adds a service, latency and a trust hop; defeats "in-process" |

Hosting long waits: **Durable Objects** are the supported home (the Agents SDK is built on them; spike above). Plain
request handlers and Workflows are not blocked, but not supported in docs until tested.

## Design

### Package layout

- `sdk-ts/src/index.ts` (Node, unchanged behaviour): binary mode.
- `sdk-ts/src/edge.ts` (new): the `workerd`/`worker`/`deno`/`bun`/`browser` export condition. Exports the same
  `Unstuck` class and types, implemented in-process. Must never import `node:*` or `engine-process.ts`
  (enforced: extend `scripts/check-runtime-agnostic.mjs` to the edge entry's import graph).
- Shared between both: `attach.ts` (already portable), types, errors, option validation.
- `sdk-ts` gains a dependency on `@velmlabs/unstuck-core`.
- On Node, `new Unstuck({ mode: 'in-process' })` also selects the in-process implementation (for tests and for Bun/Deno
  users on Node-compatible runtimes). Default stays binary on Node.

### Moving shared engine code into `core`

These live in `engine/` today but are web-standard; they move to `core/src/cloud/` and `engine` imports them back:

- Relay/viewer selection (`engine/src/transport-select.ts`): `CLOUD_RELAY_URL`, `CLOUD_VIEWER_URL`, choice from options
  (edge) or env (engine), viewer URL pinning to the engine/SDK version.
- Cloud alerts (`engine/src/cloud-alerts.ts`): device list, `sealAlert`, posting to Cloud.
- `hostnames()` filter for `allowedSites` (`engine/src/stdio-host.ts`).

### In-process takeover flow (edge entry)

1. `new Unstuck(opts)`: in a Worker, configuration comes from options only (no `process.env`):
   `apiKey` (Cloud), or `relay` + `agentKey` (self-hosted), optional `viewerUrl`, `timeoutS`, `requireCode`,
   `onLink`, `cloudApi` (staging), `fetch` (tests). No relay configured → `takeover()` throws
   `UnstuckConfigError` ("in a Worker, Unstuck needs a relay: set apiKey or relay + agentKey").
2. First `takeover()` lazily creates one engine: `createEngine({ transport: createRelayTransport(...), ... })`.
3. `attachPage(page)` → an `AttachedPage`; adapt it to core's `CdpClient` directly (no RPC tunnel).
4. `engine.takeover(cdp, { reason, timeoutS, site, requireCode, allowedSites: hostnames(...), popups, onLink })`, with
   popups from `page.on('popup')` attached the same way as on Node.
5. `onLink`: user's handler (default: `console.log` the link, since Workers have no stderr), and the Cloud alerter
   when `apiKey` is set and `alerts !== false`.
6. Results identical to binary mode (`resolved` / `cancelled` / `timed_out` / `failed`, `durationS`, `detail`).
7. `close()`: closes the engine and relay sockets.

### Options (decided after the builder check)

One shared `UnstuckOptions` type for both entries; precedence is option → environment variable → default.

| Option | Meaning | Node binary mode | Edge (Worker) |
|---|---|---|---|
| `apiKey` | Unstuck Cloud API key: Cloud relay, hosted viewer pinned to the SDK version, phone alerts | Passed to the engine as `UNSTUCK_API_KEY` (env still works) | Required for Cloud |
| `cloudRelay`, `cloudApi` | Overrides for Cloud's relay and API origins (staging); only with `apiKey` | Passed as `UNSTUCK_CLOUD_URL` / `UNSTUCK_CLOUD_API` | Options only |
| `viewerUrl` | Viewer origin override (https, or http on localhost) | Passed as `UNSTUCK_VIEWER_URL` | Options only |
| `relay` + `agentKey` | Self-hosted relay (no alerts, the relay serves the viewer) | As today | Options only |
| `enginePath`, `host`, `port` | Binary mode only | As today | Ignored (documented as Node-only in their JSDoc) |
| `mode` | `'binary'` (Node default) or `'in-process'` (edge default; opt-in on Node) | Selects | Always in-process |

- `apiKey` and `relay` together → `UnstuckConfigError` (ambiguous: the Cloud key must never be sent to an unexpected
  relay). `cloudRelay`/`cloudApi` without `apiKey` → `UnstuckConfigError`.
- On Node, `mode: 'in-process'` reads `process.env` as a fallback, exactly like binary mode; in a Worker there is no
  environment, so options only.
- Node binary mode needs no engine changes: the new options become the environment variables the engine already reads
  (the same way `relay`/`agentKey` work today).

### Timers and lifetime

The engine uses `setTimeout`/`setInterval`, the global `WebSocket` and Web Crypto: all available in Workers. Browser Rendering closes a browser after at most 10 minutes **without activity** (`keep_alive`), and before
a person opens the link nothing touches the page. So the edge entry **pings the page every 60 s** (`Runtime.evaluate`
of a constant) for the whole takeover, which keeps takeovers up to the engine's maximum (1 hour) alive. Docs still
recommend `keep_alive: 600000` on `puppeteer.launch`. The
takeover holds an outbound WebSocket to the relay and the CDP connection to the browser. In a Durable Object this keeps
the object alive (spike). Docs recommend: run takeovers from a Durable Object or an Agents SDK agent; `keep_alive` on
Browser Rendering sessions longer than the takeover timeout.

## Testing

- **Unit (sdk-ts):** option validation, missing-relay error, onLink default, alerts on/off, AttachedPage→CdpClient
  adapter, popups wiring; with core's `FakeCdp`/fake transport.
- **Import graph:** the edge entry pulls in no `node:*` module (extended `check-runtime-agnostic`).
- **Workers runtime:** `@cloudflare/vitest-pool-workers` test that imports the edge entry and runs a takeover against a
  fake CDP and a fake relay inside workerd.
- **End to end (e2e/):** `wrangler dev` running `relay-cloudflare` and a test Worker (Durable Object) that drives a
  Chromium over CDP (standing in for Browser Rendering, which `wrangler dev` can't reach offline); a human in
  Playwright taps Start and Done; the Worker returns `resolved`.
- **Manual before release:** the same Worker deployed with real Browser Rendering on staging.
- Existing Node, Python and MCP suites unchanged and green.

## Release

0.2.0 (minor: new mode, same API). Viewer unchanged unless needed (then a new hosted viewer folder as usual).
Release dry run must include an edge-entry smoke test (bundle the edge entry with esbuild for `workerd` and assert no
`node:` imports).

## Left to the builder

- Exact name of the config error class and messages (plain language, actionable).
- Whether `bun`/`deno` conditions point at the edge entry from day one or after a test (default: point them, they run
  web-standard code).
- File split inside `core/src/cloud/`.
