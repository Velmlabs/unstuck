# Relay and end-to-end encryption: design

- **Date:** 2026-11-12
- **Status:** draft for owner review
- **Parent spec:** `2026-11-12-unstuck-mvp-design.md` (§4 architecture, §6 session flow, §9 security, §10 errors, §13 week 4)
- **Next:** Unstuck Cloud C2 hosts this relay on `unstuck.sh` behind API keys, with metering, a free tier of 100 takeovers a month and Polar billing. That's a separate design in the private repo; this one only provides the hooks it needs.

## 1. Why

Today a takeover link only works where the engine's embedded server can be reached: the developer's machine, or a host they expose themselves. Agents on servers, in CI or on Workers can't hand a human a working link. A relay fixes that. The engine and the human's browser both connect *out* to a relay, which pairs them.

The relay is also what Unstuck Cloud sells. The open-source relay must be good enough to self-host, with hooks so the hosted version can add API keys, quota and billing without forking.

## 2. Goals, non-goals, anti-goals

**Goals**
1. One relay protocol with two hosts: **Cloudflare** (Worker + one Durable Object per takeover) and **Node** (plus a Docker image).
2. **End-to-end encryption.** Frames, input, tokens and codes are encrypted between engine and viewer. A relay, including Unstuck Cloud, sees only ciphertext and sizes.
3. **Relay mode in every client** with no code changes beyond configuration: TS SDK, Python SDK, MCP server, engine CLI, and in-process mode on Workers.
4. **Zero-config Cloud:** `UNSTUCK_API_KEY` alone points the engine at `wss://unstuck.sh`.
5. **Hooks** for authorization and usage events, so Cloud can enforce keys and quota and meter "takeovers a human opened".
6. The optional **6-digit code** (`require_code`) from the same milestone.

**Non-goals (this round)**
- Cloud hosting, metering storage, quota numbers or Polar. That's C2 in the private repo.
- Publishing packages to npm or PyPI, or the Docker image to a registry. We build the image and test it; publishing is the release plan.
- Notifications, Web Push enrollment and event-log forwarding to the relay (the parent spec's later weeks).
- Several agents sharing one socket (rejected approach 2 below).

**Anti-goals: it fails, even if it works, if...**
- the relay can see a screenshot, keystroke, token or code;
- a self-hoster needs Cloudflare or Unstuck Cloud to run it;
- Cloud has to fork relay code to add billing;
- someone who only knows the session URL path (no fragment) can make the agent do anything, or make the agent's owner pay.

## 3. Constraints

- `protocol/`, `core/`, `viewer/` and the new `relay-core/` import no Node built-ins (`scripts/check-runtime-agnostic.mjs` gets `relay-core/src` added).
- Coverage above 90% in every package (lines, statements, functions, branches).
- Licenses: `relay-core`, `relay-cloudflare`, `relay-node` and `viewer` are AGPL-3.0; `protocol`, `core`, `engine` and the SDKs are Apache-2.0. The relay *client* (the engine side) lives in `core`, so it's Apache.
- Nothing is published yet, so wire formats can change freely. No backward compatibility with the plaintext viewer protocol is needed.
- Web Crypto only (works on Node 22, Bun, Workers and browsers).

## 4. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| 1 | **One Durable Object per takeover.** The engine opens one socket per takeover to `/agent/<id>`; viewers connect to `/ws/<id>`; both land on the object named `<id>`. | One extra socket per takeover, which is negligible at takeover rates. Scales without limit, failures stay isolated, and Cloud gets one clean place per takeover to authorize and count. | **Chosen by the owner** |
| 2 | One object per agent connection, carrying many takeovers over one socket | Fewer sockets, but a busy or crashed object takes down all its takeovers, and per-takeover counting gets messier. | Rejected |
| 3 | One global object | Simplest code, but a single-threaded ceiling for the whole service. | Rejected |

The Node host mirrors approach 1 in memory: a map from session id to a pairing object.

## 5. Design

### 5.1 Packages

| Package | License | Contents |
|---|---|---|
| `protocol` | Apache | Adds the relay control messages (§5.3), the `code` field on `hello`, error codes `code_required` and `code_invalid`, and `e2e.ts` (AES-GCM seal/open), shared by the engine and the viewer (ruling, Plan 3 Task 1) |
| `core` | Apache | `createRelayTransport()` (the engine side, using the global `WebSocket`). `takeover.ts` generates a per-session E2E key (separate from the engine-wide HMAC token key), puts `k=` in the fragment and wraps each `ViewerConnection` so the session logic still sees plaintext messages. `Transport.publish(sessionId, { expiresAt })` gains the expiry. Optional `Transport.onStatus(sessionId, h)` reports `'up' | 'down'` (§5.6). The 6-digit code. |
| `relay-core` (new) | AGPL | `RelaySession`: pairing, envelope routing, limits, heartbeats, hooks. Host-agnostic; talks to sockets through a small interface. |
| `relay-cloudflare` (new) | AGPL | `createRelayWorker({ authorize, onEvent })` returns `{ fetch, RelaySessionDO }`; WebSocket hibernation; serves the viewer as Worker static assets; a default `src/index.ts` plus `wrangler.toml` template for self-hosting. |
| `relay-node` (new) | AGPL | `createNodeRelay({ port, authorize, onEvent })` on `ws`; serves the viewer from `@unstuck/viewer`'s build; `unstuck-relay` CLI; `Dockerfile`. |
| `viewer` | AGPL | Reads `k` from the fragment; every message both ways is now a sealed binary message (JSON included, `ping` included); prompts for the code when asked. |
| `engine` | Apache | Picks the transport from configuration (§5.6). |
| `sdk-ts`, `sdk-py` | Apache | `relay` and `agentKey` / `agent_key` options, passed to the engine as environment variables. `requireCode` / `require_code`. |

### 5.2 URLs (identical on both hosts)

| Path | Who | Behaviour |
|---|---|---|
| `GET /s/<id>` | human | Viewer page (`cache-control: no-store`, strict CSP, `Referrer-Policy: no-referrer`) while the session is live; the existing "expired or is invalid" page (404) otherwise |
| `GET /assets/*` | human | Viewer static assets |
| `WS /ws/<id>` | viewer | Viewer socket. 404 at the upgrade if there's no live agent for `<id>`. |
| `WS /agent/<id>` | engine | Agent socket. Subprotocols offered: `unstuck-relay.1` and `key.<agentKey>`. The relay answers with `unstuck-relay.1` only, so the key never echoes. |
| `GET /healthz` | ops | `{ ok: true }` |

The agent key travels in `Sec-WebSocket-Protocol`. Browsers, Node's global `WebSocket` and Workers can all set it, but none of them can set an `Authorization` header on a WebSocket. Query strings end up in logs, so they're out.

`<id>` is the existing 128-bit base64url session id. Hosts reject ids that don't match `^[A-Za-z0-9_-]{16,64}$`.

### 5.3 Wire protocol on the agent socket

The relay multiplexes every viewer connection of a session onto that session's one agent socket. Each viewer connection gets a relay-assigned connection number `c` (u32, starting at 1).

**Text frames (JSON control), relay → agent**
- `{"t":"registered"}`: the relay accepted the `hello` (first registration or a reconnect). Only now is the session live; `publish()` resolves on it (ruling, Plan 3 Task 7).
- `{"t":"open","c":N}`: a viewer connected.
- `{"t":"close","c":N}`: that viewer went away.
- `{"t":"ping"}`: heartbeat.

**Text frames (JSON control), agent → relay**
- `{"t":"hello","expiresAt":ms,"secret":"<base64url>"}`: the first message; it registers the session. The relay caps expiry at 1 hour. `secret` is 128 random bits the engine makes per session; the relay stores its SHA-256. **A reconnect replaces the agent socket only if it presents the same secret** (and the same key). Anything else gets close code 4409. Knowing the path, or sharing an agent key, isn't enough to hijack a session.
- `{"t":"close","c":N,"code":1008}`: close one viewer.
- `{"t":"pong"}`
- `{"t":"end"}`: the takeover is over. The relay closes every viewer and forgets the session.
- `{"t":"event","name":"viewer_joined"}`: informational, passed to `onEvent`.

**Binary frames, both directions:** `[c: u32 big-endian][payload]`. The payload is one E2E-sealed message (§5.4), forwarded byte for byte between the agent and viewer `c`. The viewer socket carries the bare payload with no prefix.

The relay never parses payloads. Anything else on either socket, such as unknown JSON or a binary frame for an unknown `c`, is dropped. A viewer socket that sends text is closed with 1003.

### 5.4 End-to-end encryption

- **Key:** 256-bit AES-GCM, random per session, generated in core. It sits in the link fragment as `k=<base64url>`, next to `t=`, so the link is `…/s/<id>#t=<token>&k=<key>`. It's never sent to any server.
- **Per-connection challenge (replay protection, ruling from the Plan 3 final review):** when a viewer connects, the engine's first message is a sealed `{"t":"challenge","n":<16 random bytes, base64url>}`. The viewer sends nothing until it has opened it. Every later message in both directions is bound to that nonce and to a sequence number.
- **Sealed message:** `[seq: u32 big-endian][12-byte random IV][ciphertext + 16-byte tag]`. The AAD is `"unstuck/1|" + sessionId + "|" + direction + "|" + nonce + "|" + seq`, where direction is `e2v` (engine → viewer) or `v2e`; the challenge itself uses an empty nonce and seq 0. Receivers accept only a seq greater than the last one they accepted on that connection (gaps are fine, because a relay may drop frames for a slow viewer). So a message can't be replayed into another session, another connection, or twice on the same one, or reflected back the other way.
- **Plaintext:** exactly today's messages. A first byte of `{` (0x7B) means JSON (`hello`, input, `ready`, `state`, `error`, ping/pong). A first byte of 0x01 means a JPEG frame in the existing format. Nothing else needs a type marker.
- **Every mode encrypts,** embedded included, so there's one code path and the same tests cover all modes. On loopback the cost is negligible next to JPEG encoding.
- **A message that doesn't decrypt** closes that viewer connection with 1008 and sends nothing back. Someone without the fragment learns nothing, and the agent sends no bytes their way.
- **Token, resume key and code** all travel inside sealed `hello` messages. The relay never sees them.

### 5.5 Relay behaviour (`relay-core`)

**Lifecycle**
1. An agent connects to `/agent/<id>`. The host calls `authorize(agentKey, { sessionId, ip })` before letting the agent register. On refusal it **accepts the upgrade and immediately closes it with `4000 + status`** (4401, 4402, 4403 or 4429), with `{error}` as the close reason, because WebSocket clients can't read an upgrade's HTTP status (ruling, Plan 3 Task 7). The engine maps the code (§5.7). A second agent socket for a registered `<id>` replaces the first only if its `hello` carries the session's secret and the same key; otherwise it's closed with 4409. (A different key is refused at the upgrade with 409.)
2. A viewer connects to `/ws/<id>`. If no agent is registered, the upgrade gets 404. Otherwise the relay assigns `c`, sends `open` to the agent and starts forwarding.
3. **The agent drops:** viewers are closed with 1012 ("agent reconnecting"). The session stays known for a **60 s grace period**, during which the viewer page keeps showing "reconnecting…" and retries. Its existing resume flow with `resumeKey` takes over once the agent is back. If the grace runs out, the session is forgotten.
4. **The session ends** on `end`, on expiry, or when the grace runs out. `onEvent(session_closed)` fires once.

**Limits** (constants in relay-core, overridable per host)
- Agent → viewer payload: 2 MB maximum. Viewer → agent: 64 KB maximum.
- At most 4 viewer connections at once per session. The engine already admits only one human; the rest are refused attempts.
- A 120 s idle timeout per socket. Heartbeats every 30 s: the relay pings the agent, and the viewer already pings the engine through the relay.
- Rate limits, with a host-provided hook so Cloud can replace them:
  - per IP, 30 viewer upgrades a minute;
  - per agent key, 20 agent upgrades a minute.

  Node keeps them in memory. On Cloudflare, each takeover is its own Durable Object, so the Worker checks them with the Workers Rate Limiting binding (`ratelimits` in `wrangler.toml`) before routing. That's per-location and approximate, which is fine for abuse control.
- **Backpressure:** if a viewer socket's buffered amount exceeds 4 MB, the relay drops agent → viewer payloads of **4 KB or more** for that viewer and still forwards smaller ones. Every payload is opaque, but JSON control messages (`ready`, `state`, `error`, `pong`) are well under 1 KB and screen frames are well over 4 KB, so size alone tells them apart. That leaks nothing the relay couldn't already see. The engine already sends newest-frame-only, so this only bites on very slow phones.

**Hooks**

```ts
type Authorize = (agentKey: string | null, ctx: { sessionId: string; ip: string }) =>
  Promise<{ ok: true; account: string } | { ok: false; status: 401 | 402 | 403 | 429; error: string }>;

type RelayEvent =
  | { name: 'session_opened'; sessionId: string; account: string; at: number }
  | { name: 'viewer_connected'; sessionId: string; account: string; at: number }
  | { name: 'takeover_opened'; sessionId: string; account: string; at: number }  // billable, at most once per session
  | { name: 'agent_event'; sessionId: string; account: string; event: string; at: number }
  | { name: 'session_closed'; sessionId: string; account: string; at: number;
      durationMs: number; bytesToViewers: number; bytesToAgent: number; viewers: number };

type OnEvent = (e: RelayEvent) => void | Promise<void>;
```

**`takeover_opened` is the billing signal.** It fires, at most once per session (resumes and reconnects don't count again), the first time the agent sends any viewer a payload of **4 KB or more**. That can only be a screen frame: the engine sends frames only after a valid `hello`, and the engine replays the last frame on attach, so even a static CAPTCHA page produces one. Error replies and state messages are a few hundred bytes. So this counts takeovers a human actually opened, without the relay decrypting anything, and a modified engine can't dodge it without also showing the human nothing. A link nobody opens, or that only gets an error, is never counted. The `viewer_joined` event the engine reports is passed through as `agent_event`, for history only, never for billing.

**Defaults for self-hosting**
- Agent keys come from `UNSTUCK_AGENT_KEYS` (comma-separated). Keys are compared by SHA-256 in constant time; the account is `"default"`.
- `UNSTUCK_RELAY_OPEN=1` accepts any or no key, for local testing. It logs a warning at startup and on every agent connection.
- `onEvent` defaults to one JSON line per event on stdout (Node) or `console.log` (Cloudflare).

### 5.6 Choosing relay mode (engine, SDKs, MCP)

The engine reads, in order:

1. `UNSTUCK_RELAY_URL` (for example `wss://relay.example.com`) uses that relay, with `UNSTUCK_AGENT_KEY` as the key. A missing key is allowed, for open relays.
2. Otherwise, `UNSTUCK_API_KEY` uses `wss://unstuck.sh` with that key. `UNSTUCK_CLOUD_URL` overrides the host for staging.
3. Otherwise the embedded server, as today.

The engine CLI gains `--relay <url>` and `--agent-key <key>`, which beat the environment. The startup line names the mode, for example `[unstuck] relay wss://unstuck.sh`, and never prints the key.

- **TS SDK:** `new Unstuck({ relay, agentKey })` sets those variables for the engine process it starts.
- **Python SDK:** `Unstuck(relay=..., agent_key=...)` does the same.
- **MCP** reads the same variables.
- **In-process mode** (Workers, no engine binary): `createEngine({ transport: createRelayTransport({ url, agentKey }) })`. This is the only way to run on Workers.

`createRelayTransport` implements the existing `Transport` interface:
- `publish(id)` opens `/agent/<id>`, sends `hello`, and returns `baseUrl = https://<relay-host>/s/<id>`. The `wss` host becomes `https`; `ws` becomes `http`, for local testing.
- Each relay `open` becomes a `ViewerConnection` whose `send` prefixes `c`.
- `unpublish` sends `end` and closes.
- On an unexpected drop it reconnects with exponential backoff from 0.5 s up to 30 s, while the takeover's own timeout keeps running. It reports `onStatus('down')` on the drop and `'up'` once re-registered.

**Timers during a relay outage.** While the transport is `down`, the session pauses its viewer-left timer (`RESUME_WINDOW_MS`), and restarts it in full when the transport is back `up`. The viewer restarts its own 60 s give-up window on every successful reconnect, not only on the first disconnect. The relay's 60 s grace only bounds how long it remembers a session with no agent. So a relay or network blip shorter than the takeover's timeout never fails the takeover as `viewer_left`.

### 5.7 Errors seen by the agent

| Relay answer | `takeover()` result |
|---|---|
| close 4401 or 4403 | `failed`, detail `relay_unauthorized` |
| close 4402 | `failed`, detail `relay_quota_exceeded` (Cloud's free tier is used up) |
| close 4429 | `failed`, detail `relay_rate_limited` |
| No `registered` within 15 s, or any other close before it | `failed`, detail `relay_unreachable` |
| Drop mid-takeover | reconnect with backoff; viewers see "reconnecting…"; no change in result unless the takeover times out |

`takeover()` never throws for relay errors. That matches §10 of the parent spec.

### 5.8 Six-digit code

- `requireCode` is a client option (`new Unstuck({ requireCode: true })`, `Unstuck(require_code=True)`, `UNSTUCK_REQUIRE_CODE=1` for MCP and the CLI), overridable per `takeover()` call. It makes the engine generate a random 6-digit code per session.
- The code reaches the human only out of band: `onLink({ url, code })` (so `TakeoverLinkParams` and the SDKs' link callback gain an optional `code`), the MCP log line and the stderr line. It's never in the URL.
- When the engine answers a `hello` with `error: code_required` or `code_invalid`, **it keeps that connection open** and accepts another `hello` on it (today every `reject()` closes with 1008; these two codes are the exception). The viewer shows a code prompt and sends `hello` again with `code`.
- A **resume** `hello` (valid `resumeKey`) doesn't need the code again: the resume key already proves it's the same device that entered it.
- After 5 wrong codes, the session refuses every new *token* `hello` with `session_closed`. A resume by the device already holding the session still works. `takeover()` keeps waiting until it times out, so a guessing human can't end the agent's takeover early.

### 5.9 Housekeeping

Rule: **nothing outlives its takeover.** The longest any relay state can live is the capped expiry (1 hour) plus the 60 s grace. Every piece of state has an owner that deletes it, and a backstop in case the owner never runs.

**Cloudflare (one Durable Object per takeover)**
- The object stores only the session record: account, SHA-256 of the agent secret, `expiresAt`, byte counters and the `takeover_opened` flag. It's in Durable Object storage so it survives hibernation. Screen data is never stored.
- On registration the object sets an **alarm** for `expiresAt`. When the agent drops, the alarm moves to the end of the 60 s grace; when it reconnects, back to `expiresAt`.
- **End of session** (`end`, alarm, or grace over): close every socket, fire `session_closed` once, then `storage.deleteAll()` and `deleteAlarm()`. An object with empty storage costs nothing and is gone for good.
- **Backstop:** any request or alarm that finds a record past `expiresAt + 60 s` runs the same cleanup first.

**Node**
- Sessions live in a `Map`, with one timer each for expiry and grace. End of session closes the sockets, fires `session_closed` and deletes the entry and its timers.
- **Backstop sweep every 60 s:**
  - removes any entry past `expiresAt + 60 s`;
  - removes sockets past the 120 s idle timeout;
  - prunes rate-limit buckets older than their window.
- Clean shutdown (SIGTERM/SIGINT) closes every socket with 1001 and exits within 5 s.

**Engine and SDKs**
- `unpublish` sends `end` and closes the agent socket. Engine shutdown runs `unpublish` for every live session.
- The E2E key and agent secret exist only in memory and in the link, and die with the session.

**Logs.** The relay writes nothing to disk: event lines go to stdout or `console.log`. Retention of anything `onEvent` stores is the host's job (Cloud: §8 below).

**Tests**
- After `end`, expiry and grace-out, a Durable Object's storage is empty with no alarm set.
- The Node map, timers and buckets are empty after the sweep.
- A forced crash mid-session (no `end`) is still fully cleaned up by the backstop.

**Carried into the Cloud design (C2, private repo)**, so it isn't lost:
- A daily scheduled Worker (cron trigger) deletes expired `sessions` rows, used or expired `login_tokens`, and `login_attempts` older than a day. C1 purges tokens and attempts only on new sign-ins and never deletes expired sessions; this closes that gap.
- Per-takeover usage rows are kept for the current and previous billing month, then rolled into one monthly total per account and deleted.

## 6. Testing

- **Unit:** `relay-core` with fake sockets covers pairing, multiplexing, limits, grace, the hooks and the `takeover_opened` threshold. `core` covers e2e seal/open with wrong key, wrong session, wrong direction and tampered bytes, plus the relay transport against an in-memory relay-core.
- **Hosts:**
  - `relay-cloudflare` under `@cloudflare/vitest-plugin`: DO pairing, hibernation wake, upgrade refusals;
  - `relay-node` with real `ws`.
- **End to end (Playwright):** a scripted human through the real viewer.
  - TS SDK × embedded, relay-node and relay-cloudflare (`wrangler dev`);
  - Python SDK × relay-node;
  - MCP × relay-node;
  - in-process core × relay-cloudflare.
- **Security:**
  - forwarded bytes captured at the relay contain no JPEG magic (`FF D8`), no `"hello"` and no token;
  - a link without `k`, or with the wrong `k`, gets nothing;
  - a wrong agent key gets 401, and a second key on the same id gets 409;
  - limits and rate limits;
  - code brute-force lockout.
- **Docker:** the image builds, and the e2e runs once against it.

## 7. Decided by the owner

- Approach 1: one Durable Object per takeover.
- Public relay first, then Cloud (C2) in the private repo.
- Cloud bills per takeover a human opened; free tier 100 a month (implemented in C2).

## 8. My calls (open to correction)

- **E2E in every mode, embedded included.** One path, one set of tests.
- **The agent key goes in the WebSocket subprotocol**, not a header or the query string.
- **`takeover_opened` uses the 64 KB-received threshold** rather than trusting an engine-reported event.
- **Self-host keys come from `UNSTUCK_AGENT_KEYS`**, and there's an explicit open mode.
- **The relay client is in Apache `core`,** so agents never link AGPL code.
- **Six-digit code lockout after 5 tries** leaves the takeover waiting rather than failed; resume needs no code.
- **Billing signal:** the first agent → viewer payload of 4 KB or more, once per session. This follows your rule (a takeover a human opened) and doesn't undercount small or static pages.
- **Backpressure** drops by size (4 KB or more), since everything is encrypted.
- **Relay outages pause the viewer-left timer** (new `Transport.onStatus`), so blips don't fail takeovers.
- **A per-session agent secret** guards reconnects, so a shared or open key can't hijack a session.
- **Cloudflare rate limits** use the Workers Rate Limiting binding.
- **Housekeeping (§5.9):** Durable Object alarms plus `deleteAll()`, a Node sweep every 60 s, and a daily Cloud cron for D1. Usage detail is kept 2 months, then rolled up.

## 9. Left to the builder

- Internal module layout, naming and the exact constants not listed above.
- How the viewer's assets get into `relay-cloudflare` (build step, or copy at build).
- The Dockerfile base image and size work.
- How the e2e harness starts `wrangler dev` and the Node relay.
- Exact backoff jitter.
