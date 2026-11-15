# Unstuck MVP: design spec

- **Date:** 2026-11-12
- **Status:** Draft for review
- **Scope:** Sub-project 1 of 4: the open-source core

## 1. Summary

Unstuck is the human-in-the-loop layer for browser agents. When an agent gets stuck on a CAPTCHA, login wall, 2FA prompt or any page that needs a person, Unstuck pauses the agent and sends a link to the right human. That person takes over the live browser from any device, then hands control back.

This spec covers the **open-source core**: agent SDKs (TypeScript and Python), an MCP server, a runtime-agnostic engine, a web viewer, a self-hostable relay (Node and Cloudflare Workers), local detection rules and 11 notification channels.

### Product decomposition

| # | Sub-project | Status |
|---|---|---|
| 1 | **Open-source core** (this spec) | Designing |
| 2 | Cloud v1: hosted relay, accounts, managed notifications, AI watch, usage metering | Later |
| 3 | Teams: queues and on-call, recording, audit log UI, mobile | Later |
| 4 | Billing and enterprise: plans, SSO/SAML, self-host license | Later |

### Positioning and guardrails

- Sold as **human takeover for agents**, with CAPTCHA as the entry point.
- The human is always **the customer's own person**. Unstuck never offers a crowd workforce or solving service.

## 2. Goals and success criteria

**Primary users:** indie and startup agent builders (Playwright, Puppeteer, browser-use, Stagehand, Claude/OpenAI computer use via MCP).
**Secondary users (groundwork only):** businesses running back-office agents. The MVP lays the foundations they need: secure links, end-to-end encryption, an event log and a self-hostable relay.

Success criteria:
1. A developer gets from `npm i` / `pip install` to a working takeover in **under 5 minutes**, with no infrastructure.
2. The same takeover works in: TypeScript (Node), TypeScript in-process (Cloudflare Workers, Bun, Deno), Python, and MCP.
3. Takeovers work through embedded mode, the Node relay and the Cloudflare relay, with the relay seeing only ciphertext.
4. Watch mode detects the launch rule-pack widgets on the fixture site and resolves automatically when they're solved.
5. All 11 notification channels deliver a takeover notice with a working link.

## 3. Decisions

| Topic | Decision |
|---|---|
| Environments | Browser only, over CDP. Desktop/VNC is out of scope. |
| Browser support | Tier 1: Chrome/Chromium. Tier 2 (experimental): Obscura and CDP-based hosted browsers. The engine checks capabilities when it attaches and falls back where it can (§4.4). |
| SDKs | TypeScript and Python on day one, plus an MCP server |
| Architecture | One engine, thin SDKs (Approach 1) |
| Engine runtime | Runtime-agnostic core on web-standard APIs, with a Node host (compiled binary) and an in-process host |
| Connectivity | Embedded local server by default; relay optional (Node or Cloudflare Workers); Unstuck Cloud later |
| Trigger | Explicit `takeover()` / MCP tool, plus opt-in `watch()` auto-detection |
| Detection | Rules run locally in open source; AI watch is a paid, opt-in Cloud feature (interface, redaction and mock only in the MVP) |
| Agent during takeover | Paused |
| Notifications | 11 channels; users supply their own credentials |
| Licensing | Apache-2.0: protocol, core, engine, SDKs, MCP, Astro integration. AGPL-3.0: relay-core, relay hosts, viewer. |
| Language and tooling | TypeScript 5 on Node 22; Bun `--compile` for the engine binary; Preact inside a web component for the viewer; Vitest, pytest, Playwright |

## 4. Architecture

```
Python / TS agent ── SDK (thin) ── CDP session on the developer's page
                        │  stdio JSON lines: CDP tunnel + commands
                        │  (or in-process calls on Workers/Bun/Deno)
                        ▼
                 unstuck core/engine ── embedded HTTP/WS server ── viewer (human)
                        │           └─ or outbound WS ─► relay (Node | Cloudflare DO) ◄─ viewer
                        └─ notifiers · detection rules · event log
```

The engine **never launches or owns a browser**. It sees the browser only through CDP messages tunneled by the SDK's session, so it works however the browser was started, including hosted browsers that expose CDP.

### 4.1 Repo layout

```
unstuck/                      (pnpm workspace + uv workspace)
├─ protocol/             Apache   JSON Schemas for every message; shared test cases (cases/*.json)
├─ core/                 Apache   runtime-agnostic engine (no Node built-ins)
│   ├─ session/            lifecycle state machine, event log
│   ├─ stream/             screencast → frames; viewer input → CDP Input.*
│   ├─ detect/             rule engine, Detector interface, packs/*.json, redaction
│   ├─ notify/             Notifier interface + fetch-based adapters
│   ├─ crypto/             tokens, AES-GCM end-to-end encryption
│   └─ transport/          Transport interface
├─ engine/               Apache   Node host: stdio bridge, embedded server, SMTP + desktop notifiers, MCP mode, CLI, binary build
├─ relay-core/           AGPL     session pairing and routing, host-agnostic
├─ relay-node/           AGPL     Node host + Docker image
├─ relay-cloudflare/     AGPL     Worker + Durable Object host, wrangler template
├─ viewer/               AGPL     <unstuck-viewer> web component (Preact) + standalone page
├─ integrations/astro/   Apache   @unstuck/astro: /takeover/[id] route + component
├─ sdk-ts/               Apache   npm "unstuck": binary mode | in-process mode
├─ sdk-py/               Apache   PyPI "unstuck" + platform wheels bundling the engine
├─ examples/             playwright-ts, puppeteer, browser-use, stagehand, mcp-claude,
│                        cloudflare-browser-rendering, astro-dashboard
└─ docs/
```

### 4.2 Unit responsibilities

| Unit | Does | Depends on |
|---|---|---|
| protocol | Defines all messages: SDK↔engine, engine↔relay, engine/relay↔viewer | nothing |
| core | Sessions, streaming, detection, notifiers, crypto, transport interface | protocol, web APIs only |
| engine | Hosts core in Node: stdio bridge, embedded server, Node-only notifiers, MCP server, CLI (`unstuck doctor`, `unstuck rules test`) | core |
| relay-core | Pairs agent and viewer sockets by session ID; forwards opaque encrypted frames; rate limits | protocol |
| relay-node / relay-cloudflare | Host relay-core on Node or as one Durable Object per session (WebSocket hibernation) | relay-core |
| viewer | Canvas rendering, input capture and scaling, Done / Can't-solve, Web Push subscription | protocol |
| sdk-ts / sdk-py | Start the engine (or core in-process), attach a CDP session, tunnel CDP, pause agent calls during takeover, expose the public API. About 300–500 lines each, no business logic. | protocol, engine binary |
| integrations/astro | Adds a takeover route that renders `<unstuck-viewer>` | viewer |

### 4.3 Runtime rules

- `core/`, `relay-core/` and `viewer/` must not import Node built-ins. A lint rule enforces this, and CI runs core tests under Node and `workerd` (Miniflare).
- Node-only features (SMTP, desktop notifications, stdio, child processes, binding a port) live only in `engine/` and `relay-node/`.
- The TypeScript SDK picks its mode automatically: **binary mode** under Node, **in-process mode** elsewhere. The API is the same in both.
- In-process mode on Workers has no embedded server, so it requires a relay.

### 4.4 Browser compatibility

Unstuck attaches to any browser that speaks CDP; it never launches or bundles one.

| Tier | Browsers | Guarantee |
|---|---|---|
| **Tier 1** (recommended) | Chrome / Chromium via Playwright or Puppeteer | Full end-to-end test matrix in CI (§11) |
| **Tier 2** (experimental) | CDP-based hosted browsers: Browserbase, Steel, Cloudflare Browser Rendering | CDP compatibility suite in CI (§11); documented known gaps |
| **Limited** | [Obscura](https://github.com/h4ckf0r0day/obscura) 0.2.6 (`obscura serve`, own Rust engine, not Chromium) | First-party pages only (login, 2FA, confirmations). **Not for CAPTCHAs:** it doesn't paint cross-origin iframes, so CAPTCHA widgets are blank (`docs/spikes/obscura.md`). Re-probed on each release. |

**Capability check:** when it attaches, the engine checks which CDP features the browser supports and records them on the session (event log + `result.detail`):

| Capability | Check | Fallback when missing |
|---|---|---|
| Screencast | `Page.startScreencast` succeeds | Poll `Page.captureScreenshot` at ~5 fps |
| Text paste | `Input.insertText` succeeds | Per-character `Input.dispatchKeyEvent` |
| Cross-origin iframes | `Target.setAutoAttach` reports iframe targets on a fixture page | Warn: "CAPTCHA iframes may not be detectable or done-checkable; human Done button required" |
| Popup tracking | `Target.targetCreated` fires for `window.open` | Warn; stream stays on the original page |
| Cross-origin iframe paint | Screenshot of a solid-colour cross-origin iframe shows that colour | `captcha.*` rules return `failed: browser_cannot_render_captcha` with a hint to use Chromium; first-party takeovers still allowed |
| Input | `Input.dispatchMouseEvent` / `dispatchKeyEvent` succeed | None. Takeover fails with `failed: browser does not support input` |

`unstuck doctor --cdp <url>` prints this capability report for any browser.

**Positioning:** Obscura and other stealth-oriented browsers are listed only as *compatible browsers*. Unstuck docs never promote evading detection; the intended use stays the customer's own people on the customer's own accounts.

## 5. Public API

Python shown; TypeScript is the same in camelCase.

```python
from unstuck import Unstuck, Slack, Discord, Email

unstuck = Unstuck(
    notify=[Slack(url=...), Discord(url=...), Email(to="me@example.com")],
    relay="wss://relay.example.com",   # optional; omit for embedded mode
    agent_key=...,                     # required when using a relay
    require_code=False,                # 6-digit code from the notification
    escalate_after=None,               # seconds; e.g. 120
    escalate_to=[...],                 # notifiers for the escalation round
)

result = await unstuck.takeover(page, reason="Solve CAPTCHA", timeout=600)
# result.status: "resolved" | "timed_out" | "cancelled" | "failed"
# result.url, result.session_id, result.duration_s, result.detail

watcher = unstuck.watch(page, rules=["captcha", "login", "2fa"])
watcher.on("takeover", handler)   # optional observer
watcher.stop()
```

- `page`: a Playwright `Page` (TypeScript or Python), a Puppeteer `Page` (TypeScript only), or a CDP URL plus target ID. Adapters for browser-use and Stagehand wrap these.
- **MCP tool:** `request_human_takeover(reason, cdp_url?, target_id?, timeout?)` blocks until the takeover ends and returns the same result fields. The MCP server is configured with the same options through environment variables or a config file.

## 6. Session lifecycle and data flow

```
created → notifying → waiting ─(viewer joins)→ active ─(done)→ resolved
                         │                       │
                         └──── timeout / cancel ─┴→ timed_out | cancelled
                                                  └→ failed
```

1. **Create:** 128-bit random session ID, a token HMAC-signed by the engine, a per-session AES-GCM key, and an expiry (default 600 s).
2. **Link:** embedded mode gives `http://127.0.0.1:<port>/s/<id>#t=<token>&k=<key>`. Relay mode registers the session on the agent's outbound WebSocket and gives `https://<relay>/s/<id>#t=…&k=…`. The token and key live in the URL fragment so they never reach server logs.
3. **Notify:** all notifiers fire in parallel (§8).
4. **Join:** the first viewer to redeem the token holds the session (single viewer, single use). If `require_code` is set, the viewer must also enter the 6-digit code.
5. **Stream:** `Page.startScreencast`; JPEG frames are encrypted and sent as **binary** WebSocket messages, newest frame only (slow viewers skip frames).
6. **Input:** the viewer sends mouse, wheel, key and paste events in page CSS pixels. The engine replays them via `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent` and `Input.insertText`.
7. **Agent paused:** the SDK holds the agent's page calls until the session ends.
8. **Done:** the rule's success check passes, or the human taps **Done** (→ `resolved`) or **Can't solve** (→ `cancelled`). The engine stops the screencast, revokes the token, closes the viewer and resolves `takeover()`.
9. **Event log:** structured events (created, notified{channel,ok}, viewer_joined, input_count, state changes, durations) appended as JSON lines locally, and forwarded to the relay when connected. No screenshots, keystrokes or secrets.

### Watch mode

Runs rule checks on navigation, debounced DOM mutations, and a poll every 3 s. When a rule matches, it calls `takeover()` with that rule's reason and done check. A per-rule, per-page 30-second cooldown after resolution prevents a double trigger.

## 7. Detection

### 7.1 Rule packs

JSON files shared by every runtime:

```json
{
  "id": "captcha.recaptcha-v2",
  "kind": "captcha",
  "match":   { "anyFrameUrl": ["google.com/recaptcha/api2/anchor", "recaptcha.net/recaptcha"] },
  "visible": true,
  "done":    { "anyOf": [ { "inputFilled": "[name=g-recaptcha-response]" },
                          { "frameGone": "recaptcha/api2/bframe" } ] },
  "allowOrigins": ["https://www.google.com", "https://www.recaptcha.net"],
  "reason":  "Solve the reCAPTCHA"
}
```

- **Match primitives:** `anyFrameUrl`, `selector` (present and visible), `urlPattern`, `textPattern`, `inputAutocomplete` (`one-time-code`, `current-password`).
- **Done primitives:** `inputFilled`, `elementGone`, `frameGone`, `urlChanged`, `urlMatches`, plus the human Done button.
- **Launch packs:** reCAPTCHA v2 and invisible, hCaptcha, Cloudflare Turnstile and its full-page challenge, Arkose/FunCaptcha, generic login form, 2FA/OTP input.
- Checks run read-only through tunneled `Runtime.evaluate` and `DOM` calls.
- CLI: `unstuck rules test <url> [--pack path]`.

### 7.2 Detector interface and AI watch hook

`Detector.check(pageContext) → Detection | null`. Implementations:
- `RuleDetector`: the MVP default.
- `CloudDetector`: a stub that posts a **redacted**, downscaled screenshot plus page context to Unstuck Cloud. It's tested against a mock server only; the real model belongs in the Cloud v1 spec.
- **Redaction** ships in the MVP: blurs `input[type=password]`, inputs with `autocomplete` values for credentials or payment cards, and any element marked `data-unstuck-redact`, before an image leaves the machine. The same redaction applies to notification thumbnails.

## 8. Notifications

> **Superseded (2026-11-14).** The `Notifier` channels below were never built. Takeover notifications are now Unstuck Cloud alerts: the engine seals the link to the user's paired phones and Cloud delivers it by Web Push, Telegram or email. See the notifications design (`docs/specs/2026-11-14-notifications-design.md` in the unstuck-cloud repo, sections 4.2 and 4.8). Developers can still send the link anywhere from `onLink`. The text below is kept as the record of the original plan.

Interface: `Notifier.send(notice: TakeoverNotice) → { ok, error? }`. A notice carries the reason, site domain, an optional thumbnail (redacted; per-channel `thumbnail: false`), the link, the expiry, the session ID and the 6-digit code when enabled.

| # | Channel | Runtime | Config |
|---|---|---|---|
| 1 | Webhook | all | URL, HMAC secret (`X-Unstuck-Signature`) |
| 2 | Slack | all | incoming-webhook URL; Block Kit with an Open button |
| 3 | Mattermost / Rocket.Chat | all | Slack-compatible webhook URL (reuses the Slack adapter) |
| 4 | Discord | all | channel webhook URL; embed titled with the reason and linking to the viewer, `<t:…:R>` expiry, image thumbnail, optional role mention |
| 5 | Telegram | all | bot token, chat ID; `sendPhoto`/`sendMessage` with an inline-keyboard URL button |
| 6 | Microsoft Teams | all | Teams **Workflows** webhook URL; Adaptive Card with an Open action |
| 7 | Google Chat | all | space webhook URL; card with a button |
| 8 | Email | Resend/SendGrid: all; SMTP: Node only | API key or SMTP URL; from/to |
| 9 | SMS | all | Twilio SID, auth token, from/to; link only |
| 10 | Push | all | Web Push (VAPID keys; viewer-registered subscriptions), ntfy topic, Pushover app token and user key |
| 11 | Desktop | Node local only | none |

- Secrets come from environment variables (`UNSTUCK_SLACK_URL`, `UNSTUCK_DISCORD_URL`, `UNSTUCK_TELEGRAM_TOKEN` …) or explicit configuration.
- Each send has a 10 s timeout and 2 retries with exponential backoff; sends run in parallel. Failures are logged and never block the takeover.
- **Escalation:** if `escalate_after` is set and nobody has joined in time, a second round goes to `escalate_to`.
- **Web Push enrollment:** the viewer offers "Notify me on this device"; the subscription is stored by the engine (local file) or the relay (Durable Object storage on Cloudflare, a file or SQLite on Node).
- **Later:** WhatsApp (managed in Cloud), PagerDuty/Opsgenie (Teams tier), LINE, Matrix. New channels are one adapter each.
- **Not feasible:** Signal, iMessage (no official APIs).

## 9. Security

- **Tokens:** 128-bit session ID; HMAC-signed token in the URL fragment; single viewer, single use; default expiry 600 s; optional 6-digit code (`require_code`).
- **End-to-end encryption:** per-session AES-GCM key in the URL fragment; frames and input are encrypted between engine and viewer. Relays, including Unstuck Cloud, only forward ciphertext.
- **Limiting the human:** during a takeover, navigation is allowed only to the page's current site plus the matching rule's `allowOrigins`. Downloads are blocked; file choosers are auto-cancelled. The viewer exposes only mouse, keyboard and paste.
- **Embedded mode** binds to `127.0.0.1`; `host: "0.0.0.0"` is opt-in and prints a warning.
- **Viewer:** strict CSP, no third-party scripts, `Referrer-Policy: no-referrer`.
- **Relay:** agent key required to register sessions (`--open` mode for local testing only); per-IP and per-agent rate limits; 2 MB maximum frame size; 120 s idle timeout on sockets, with agents and viewers sending a heartbeat every 30 s so that sessions in `waiting` stay open.
- **Logs:** no screenshots, keystrokes or secrets; notifier secrets redacted from errors.

## 10. Error handling

| Failure | Behaviour |
|---|---|
| Viewer disconnects | Session goes back to `waiting`; the same device can resume within 5 minutes (`RESUME_WINDOW_MS`, long enough to read a code in another app) with the session's resume key |
| Relay connection drops | Engine reconnects with exponential backoff (max 30 s); the session survives; viewer shows "reconnecting…" |
| Page closes or CDP error | `failed` with detail; `takeover()` returns, it doesn't throw |
| Engine process crashes | SDK detects the closed pipe, raises `UnstuckEngineError`, restarts the engine on the next call |
| CAPTCHA opens a popup or new tab | Engine follows new targets the page opens and switches the stream to the active one |
| CAPTCHA in a cross-origin iframe | Works as-is (composited screencast; top-level input coordinates) |
| Nobody joins | Optional escalation round, then `timed_out` |
| All notifiers fail | Takeover continues; link in the result and the log; warning raised |
| Done check never fires | Human Done or Can't-solve buttons |

## 11. Testing

| Layer | Approach |
|---|---|
| protocol | Schema validation; shared test cases in `protocol/cases/*.json` run by both SDKs and the engine |
| core | Vitest under both Node and `workerd` (Miniflare) |
| notifiers | Recorded HTTP mocks with golden payloads per channel; manual smoke checks against real services before release |
| detection | Local fixture site with safe stand-ins reproducing each widget's DOM and iframe structure, plus the official public test sitekeys for reCAPTCHA, hCaptcha and Turnstile. No live third-party sites in CI. |
| end-to-end | Playwright: an agent browser plus a scripted "human" browser using the viewer. Matrix: TS binary, TS in-process, Python, MCP × embedded, relay-node, relay-cloudflare (local wrangler). |
| browser compatibility | Tier 2 suite: the capability check, fixture-site detection, and one scripted takeover, run against Obscura (`obscura serve` in Docker) and local stand-ins for hosted browsers. Reports pass, fallback or fail per capability; fallbacks don't fail CI, regressions in a previously passing capability do. |
| security | Token reuse, expiry, wrong code, cross-origin navigation block, relay sees only ciphertext, rate limits |
| binaries | Build for linux-x64/arm64, macOS-x64/arm64, windows-x64; `unstuck doctor` plus one end-to-end smoke test per OS |

## 12. Release

- **npm:** `unstuck`, `@unstuck/engine-<os>-<arch>`, `@unstuck/viewer`, `@unstuck/astro`, `@unstuck/relay`
- **PyPI:** `unstuck` with platform wheels
- **Docker:** `ghcr.io/velmlabs/unstuck-relay`
- **Cloudflare:** wrangler template plus a Deploy-to-Workers button
- **Versioning:** Changesets, one version across packages
- **Name (decided 2026-11-12):** the product is **Unstuck**, renamed from the working name "Gotcha" because `gotcha` was taken on npm and PyPI. `unstuck` was free on both on 2026-11-12, and `unstuck.sh` had no DNS records (likely unregistered). **First release task:** register `unstuck.sh`, publish placeholder `unstuck` packages on npm and PyPI, and create the `@unstuck` npm org (fallback scope `@unstuck-sh/*`). Repo rename to `unstuck` is optional and up to the owner; the Docker image path follows the repo name.

## 13. Milestones (about 8 weeks solo)

| Week | Deliverable |
|---|---|
| 1–2 | protocol, core session/stream, engine binary, embedded transport, viewer, TS SDK. **Demo: local takeover.** |
| 3 | Python SDK, MCP server, rule packs, watch mode, fixture site, end-to-end harness |
| 4 | relay-core, relay-node, relay-cloudflare, end-to-end encryption, 6-digit code |
| 5–6 | 11 notification channels, escalation, Web Push enrollment |
| 7 | `<unstuck-viewer>` component, Astro integration, Cloudflare Browser Rendering example |
| 8 | Docs, examples, demo video, release pipeline, launch |

## 14. Risks and open items

1. **Cloudflare Browser Rendering CDP support:** unverified whether `@cloudflare/puppeteer` passes through `Page.startScreencast` and `Input.dispatch*`. *First implementation task:* a spike. Fallback: poll `Page.captureScreenshot` at ~5 fps.
2. **Bun `--compile` cross-target reliability** for 5 targets. Fallback: Node single-executable applications.
3. **Package-name availability** on npm and PyPI (§12).
4. **Playwright Python CDP sessions:** confirm `page.context.new_cdp_session(page)` supports the event volume of screencast frames; fallback is connecting the engine directly to the browser's CDP URL when one is exposed.
5. **Obscura compatibility (spiked 2026-11-12, see `docs/spikes/obscura.md`):** result: core CDP works, but cross-origin iframes aren't painted and popups aren't reported, so Obscura is "Limited" (first-party pages only). Original note: Obscura documents screencast, screenshots, mouse/key input and `Runtime.evaluate`, but doesn't mention `Input.insertText`, cross-origin iframes or popup events. Its own renderer may also draw CAPTCHA widgets differently from Chromium, and CAPTCHA providers may challenge it harder. *Spike (early in the plan):* run the capability check, the fixture site and the official reCAPTCHA/hCaptcha/Turnstile test pages against `obscura serve`. The result decides which gaps the docs list and whether Obscura stays Tier 2.
6. **License boundaries:** the AGPL viewer is served by the Apache engine and used by the Apache Astro integration. It's shipped as a separate package (`@unstuck/viewer`) and loaded as an unmodified separate work, never compiled into Apache code. Confirm this split with a licensing review before launch, or relicense the viewer as Apache-2.0 if it adds friction.
7. **Abuse:** the open-source software can't be policed; docs and terms state intended use (your own people, your own accounts). Cloud abuse controls belong to the Cloud v1 spec.

## 15. Out of scope

VNC/desktop streaming; Go/Rust SDKs; the real AI watch model; hosted Unstuck Cloud (accounts, billing, dashboard); team queues and on-call; session recording; SSO; WhatsApp, PagerDuty/Opsgenie, LINE, Matrix; native mobile apps; letting the agent run during a takeover.
