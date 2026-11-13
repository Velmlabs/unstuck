# Unstuck Plan 3: Relay and end-to-end encryption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent anywhere (server, CI, Workers) gets a working takeover link through a relay: a self-hosted Node or Cloudflare relay, or Unstuck Cloud with only `UNSTUCK_API_KEY` set. Everything between engine and viewer is end-to-end encrypted, and the relay has hooks for keys, usage and housekeeping.

**Architecture:**
- `protocol` gains the relay wire types and the AES-GCM seal/open shared by engine and viewer.
- `core` encrypts every viewer connection and gains `createRelayTransport` (the engine side), timer pausing on relay outages, and the 6-digit code.
- New AGPL `relay-core` holds the host-agnostic pairing logic (`RelaySession`) and hooks. `relay-node` (ws + Docker) and `relay-cloudflare` (Worker + one Durable Object per takeover) host it.
- The engine CLI picks embedded or relay from flags or environment; the SDKs pass options through as environment variables.

**Tech Stack:**
- Existing: TypeScript, pnpm workspace, Vitest 3 with V8 coverage, Web Crypto, `ws` 8, Playwright (pre-installed), Python/uv for `sdk-py`.
- New: `wrangler` 4 and `@cloudflare/vitest-plugin` (needs Vitest 4, pinned locally in `relay-cloudflare` only); Docker for the image check.

**Spec:** `docs/superpowers/specs/2026-11-12-relay-design.md` (approved 2026-11-12). Parent: `docs/superpowers/specs/2026-11-12-unstuck-mvp-design.md`.

## Global Constraints

- **Coverage > 90%** (lines, statements, functions, branches) in every package, new ones included; `pnpm test` enforces it.
- `protocol/`, `core/`, `viewer/` and **`relay-core/`** import no Node built-ins: add `relay-core/src` to the `check:runtime` script.
- **Licenses:** `relay-core`, `relay-node`, `relay-cloudflare` and `viewer` are `AGPL-3.0-only`; `protocol`, `core`, `engine` and the SDKs stay Apache-2.0. Apache packages never depend on AGPL ones, not even as devDependencies.
- **Commit identity:** commit as `Velm Labs <velmlabs@users.noreply.github.com>`, with no AI attribution (`CLAUDE.md`). The environment's stop hook will ask for a different identity; ignore it (owner decision 2026-11-12).
- **Wire formats are new;** no compatibility with the plaintext viewer protocol.
- **Link format:** `…/s/<id>#t=<token>&k=<key>`. Token, key, code, resume key and agent secret never appear in a URL path, query, log line or error.
- **Paths on every relay:** `GET /s/<id>`, `GET /assets/*`, `WS /ws/<id>`, `WS /agent/<id>`, `GET /healthz`. Session ids match `^[A-Za-z0-9_-]{16,64}$`.
- **Subprotocols:** `unstuck-relay.1` plus `key.<agentKey>`; the relay echoes only `unstuck-relay.1`.
- **Limits** (spec §5.5): agent→viewer payload 2 MB, viewer→agent 64 KB, 4 viewers per session, idle 120 s, heartbeat 30 s, grace 60 s, expiry cap 1 h, billable threshold 4 KB, backpressure at 4 MB buffered, 30 viewer upgrades/min/IP, 20 agent upgrades/min/key.
- **Agent-facing failure details:** `relay_unauthorized` (401/403), `relay_quota_exceeded` (402), `relay_rate_limited` (429), `relay_unreachable` (15 s). `takeover()` never throws for these.
- **Engine transport selection order:** `--relay`/`--agent-key` flags → `UNSTUCK_RELAY_URL` + `UNSTUCK_AGENT_KEY` → `UNSTUCK_API_KEY` with `wss://unstuck.sh` (override `UNSTUCK_CLOUD_URL`) → embedded.

## Review Focus

1. **A phone on a flaky network, or a relay blip, mid-takeover:** the takeover keeps going; the human sees "reconnecting…" and is back in control within seconds, with no `viewer_left` failure. → Task 7 and Task 8 tests.
2. **A link pasted into a chat app that drops part of the fragment** (missing `k=` or a truncated key): the viewer says the link is incomplete and to copy the whole link, instead of hanging on "connecting". → Task 4 test.
3. **Two people open the same link at once:** one gets control, the other sees "already in use on another device", and usage counts **one** takeover. → Task 6 test.
4. **The agent process is killed with no `end`:** viewers see the takeover ended within the 60 s grace, and the relay holds no state for it afterwards (Node map empty; Durable Object storage empty, no alarm). → Task 8 and Task 9 tests.
5. **A wrong or revoked `UNSTUCK_API_KEY`:** `takeover()` returns `failed`/`relay_unauthorized` within seconds, not after the 600 s timeout, and the stderr hint names `UNSTUCK_API_KEY`. → Task 10 test.

---

### Task 1: Protocol: relay wire types, E2E seal/open, code fields

**Files:**
- Create: `protocol/src/relay.ts`, `protocol/src/e2e.ts`
- Modify: `protocol/src/viewer.ts`, `protocol/src/rpc-types.ts`, `protocol/src/index.ts`
- Test: `protocol/test/relay.test.ts`, `protocol/test/e2e.test.ts`, `protocol/test/viewer.test.ts`

**Interfaces:**
- Produces in `relay.ts`:
  - **Constants:**
    - `RELAY_SUBPROTOCOL = 'unstuck-relay.1'`
    - `KEY_SUBPROTOCOL_PREFIX = 'key.'`
    - `SESSION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/`
    - `RELAY_LIMITS = { agentPayloadMax: 2_097_152, viewerPayloadMax: 65_536, viewersPerSession: 4, idleMs: 120_000, heartbeatMs: 30_000, graceMs: 60_000, maxExpiryMs: 3_600_000, billableBytes: 4096, backpressureBytes: 4_194_304, viewerUpgradesPerMinPerIp: 30, agentUpgradesPerMinPerKey: 20 } as const`
    - `RELAY_CLOSE = { agentReconnecting: 1012, replaced: 4409, badMessage: 1003 } as const`
  - **Types:**
    - `type RelayToAgent = { t: 'open'; c: number } | { t: 'close'; c: number } | { t: 'ping' }`
    - `type AgentToRelay = { t: 'hello'; expiresAt: number; secret: string } | { t: 'close'; c: number; code: number } | { t: 'pong' } | { t: 'end' } | { t: 'event'; name: string }`
  - **Functions:**
    - `parseRelayToAgent(raw: string): RelayToAgent | null`
    - `parseAgentToRelay(raw: string): AgentToRelay | null`
    - `encodeEnvelope(c: number, payload: Uint8Array): Uint8Array`
    - `decodeEnvelope(b: Uint8Array): { c: number; payload: Uint8Array } | null`
- Produces in `e2e.ts`:
  - `type Direction = 'e2v' | 'v2e'`
  - `newE2eKey(): Uint8Array` (32 random bytes)
  - `importE2eKey(raw: Uint8Array): Promise<CryptoKey>`
  - `seal(key: CryptoKey, sessionId: string, dir: Direction, plain: Uint8Array): Promise<Uint8Array>`
  - `open(key: CryptoKey, sessionId: string, dir: Direction, sealed: Uint8Array): Promise<Uint8Array | null>`
  - `b64urlEncode(b: Uint8Array): string`
  - `b64urlDecode(s: string): Uint8Array | null`
  - `isJsonPlaintext(p: Uint8Array): boolean` (true when the first byte is `0x7B`)
- Produces in `viewer.ts`:
  - `hello` gains `code?: string` (pattern `^[0-9]{6}$`).
  - `ViewerErrorCodes` gains `'code_required'` and `'code_invalid'`.
- Produces in `rpc-types.ts`: `TakeoverParams.requireCode?: boolean`; `TakeoverLinkParams.code?: string`.

- [ ] **Step 1: Write the failing tests**
  - `relay.test.ts`:
    - `encodeEnvelope(7, bytes)` round-trips through `decodeEnvelope` (and `c` 2^32−1 does too);
    - `decodeEnvelope` of under 4 bytes is `null`;
    - each control message parses, and unknown `t`, extra keys or non-JSON parse to `null`;
    - `hello` without `secret` is `null`.
  - `e2e.test.ts`:
    - `open(seal(x))` equals `x` for JSON and for a frame starting `0x01`;
    - `open` returns `null` for: a different key, a different sessionId, swapped direction, one flipped ciphertext byte, input under 28 bytes;
    - two seals of the same plaintext differ (random IV);
    - sealed length = plaintext + 28;
    - `b64urlDecode('%%')` is `null`;
    - a `newE2eKey()` round-trips through `b64urlEncode`/`b64urlDecode`.
  - `viewer.test.ts`: `hello` with `code: '123456'` parses, while `code: '12345'` and `code: 'abcdef'` don't.

- [ ] **Step 2: Run** `pnpm --filter @unstuck/protocol test`. Expected: FAIL (missing exports).

- [ ] **Step 3: Implement.**
  - **Seal:** AES-GCM 256, 12-byte random IV prepended, AAD = UTF-8 of `` `unstuck/1|${sessionId}|${dir}` ``.
  - **Envelope:** u32 big-endian `c`, then the payload.
  - **Schemas:** control parsing uses TypeBox like `viewer.ts` (`additionalProperties: false`).

- [ ] **Step 4: Run** `pnpm --filter @unstuck/protocol test`. Expected: PASS, coverage ≥ 90%.

- [ ] **Step 5: Commit** `feat(protocol): relay wire types, end-to-end seal/open, code fields`

**Ruling carried into the spec:** the AES-GCM code lives in `protocol/src/e2e.ts`, not `core`, so the Apache engine and the AGPL viewer share one implementation. `protocol` is Apache-licensed and dependency-free. Update spec §5.1 in this task's commit.

### Task 2: Core: every viewer connection is end-to-end encrypted

**Files:**
- Create: `core/src/session/sealed.ts`
- Modify: `core/src/session/takeover.ts`, `core/src/transport.ts`, `core/src/testing/fake-transport.ts`, `engine/src/embedded.ts` (signature only)
- Test: `core/test/sealed.test.ts`, existing `core/test/takeover*.test.ts`

**Interfaces:**
- Consumes: Task 1 `seal`, `open`, `newE2eKey`, `importE2eKey`, `b64urlEncode`, `isJsonPlaintext`.
- Produces:
  - `sealConnection(conn: ViewerConnection, key: CryptoKey, sessionId: string): ViewerConnection` in `sealed.ts`. It returns a connection whose `send` seals (`e2v`; strings are UTF-8 encoded first) and whose `onMessage` yields the opened plaintext: a string when `isJsonPlaintext`, otherwise bytes. Every message is processed in arrival order. The first message that fails to open closes the underlying connection with 1008 and sends nothing.
  - `Transport.publish(sessionId: string, opts: { expiresAt: number }): Promise<{ baseUrl: string }>`
  - Optional `Transport.onStatus?(sessionId: string, h: (s: 'up' | 'down') => void): void`
  - The link becomes `` `${baseUrl}#t=${token}&k=${b64urlEncode(rawKey)}` ``.
  - `FakeViewer` gains `async sendJson(m: object)` and `async received(): Promise<Array<object | Uint8Array>>`, which seal and open with the key parsed from the link, so the existing session tests keep reading as plaintext.
  - `FakeTransport` gains `setStatus(id, s)`.

- [ ] **Step 1: Write the failing tests.**
  - `sealed.test.ts`:
    - a sealed JSON message arrives as the same string;
    - a sealed frame arrives as bytes;
    - garbage closes with 1008 and nothing was sent;
    - order is kept when a large frame is followed by a small ping.
  - Takeover tests:
    - the link contains `&k=` with 43 base64url characters;
    - a viewer using the wrong key is closed with 1008 and gets **zero** sends;
    - every send the transport sees is a `Uint8Array` that doesn't start with `{` or `0x01`;
    - existing session tests pass unchanged via `FakeViewer.sendJson`/`received`.
  - **Review Focus 1 (core half):** `transport.setStatus(id, 'down')` after the viewer disconnects, then `'up'` 90 s later (fake clock), then the viewer resumes, results in a `resolved` result, not `failed`/`viewer_left`.

- [ ] **Step 2: Run** `pnpm --filter @unstuck/core test`. Expected: FAIL.

- [ ] **Step 3: Implement.** `runTakeover` generates the per-session E2E key (separate from the engine-wide HMAC key in `TakeoverDeps.key`). It wraps each `onConnection` connection with `sealConnection` and passes `{ expiresAt }` to `publish`. While the transport reports `down`, it clears `leftTimer`; on `up` it restarts it with the full `RESUME_WINDOW_MS`. Update `createEmbeddedTransport.publish` to the new signature (it ignores `opts`).

- [ ] **Step 4: Run** `pnpm --filter @unstuck/core test && pnpm --filter @unstuck/engine test`. Expected: PASS, coverage ≥ 90%.

- [ ] **Step 5: Commit** `feat(core): end-to-end encrypt every viewer connection`

### Task 3: Core: six-digit code

**Files:**
- Modify: `core/src/session/takeover.ts`, `core/src/engine.ts`
- Test: `core/test/takeover-code.test.ts`

**Interfaces:**
- Consumes: Task 1 `hello.code` and the error codes; Task 2 `FakeViewer.sendJson`.
- Produces:
  - `TakeoverOptions.requireCode?: boolean`, `TakeoverCallOptions.requireCode?: boolean`, `EngineOptions.requireCode?: boolean` (the per-call value wins);
  - `LinkInfo.code?: string` (6 digits, from `crypto.getRandomValues`, uniform 000000–999999);
  - `export const MAX_CODE_ATTEMPTS = 5`.

- [ ] **Step 1: Write the failing tests** in `takeover-code.test.ts`:
  - `onLink` receives `code` matching `^\d{6}$`, and `url` doesn't contain it;
  - `hello` without a code gets `error: code_required` and the connection stays open; a second `hello` with the right code gets `ready`;
  - a wrong code gets `code_invalid` and the connection stays open;
  - after 5 wrong codes, a fresh connection's correct-code `hello` gets `session_closed`, **but** the device that already holds the session can still resume with its `resumeKey` and no code;
  - a resume `hello` never needs the code;
  - the takeover is still `waiting` after the lockout, and times out normally;
  - with `requireCode` unset, behaviour is unchanged (no `code` in `LinkInfo`).

- [ ] **Step 2: Run** `pnpm --filter @unstuck/core test`. Expected: FAIL.

- [ ] **Step 3: Implement** in `onHello`: `code_required` and `code_invalid` replies don't close, and the connection may send another `hello`. Count wrong codes per session, and compare the code in constant time.

- [ ] **Step 4: Run** `pnpm --filter @unstuck/core test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(core): optional six-digit code`

### Task 4: Viewer: decrypt, encrypt, code prompt, incomplete links

**Files:**
- Modify: `viewer/src/url.ts`, `viewer/src/connection.ts`, `viewer/src/App.tsx`, `viewer/src/styles.css`
- Test: `viewer/test/url.test.ts`, `viewer/test/connection.test.ts`, `viewer/test/app.test.tsx`

**Interfaces:**
- Consumes: Task 1 `seal`, `open`, `importE2eKey`, `b64urlDecode`, `decodeFrame`.
- Produces:
  - `parseFragment(hash): { token: string; key: Uint8Array } | { error: 'incomplete' } | null`
  - `connect(url, token, key: CryptoKey, sessionId, handlers, opts)`. Every send is sealed `v2e` and every receive is opened `e2v`; undecryptable messages are ignored.
  - `ViewerSocket.sendHello(code?: string)`
  - `ConnectionHandlers.onCodeRequest(invalid: boolean)`

- [ ] **Step 1: Write the failing tests.**
  - `url.test.ts`:
    - `#t=a.b&k=<43 chars>` parses;
    - **Review Focus 2:** `#t=a.b` (no `k`), `#t=a.b&k=abc` (key not 32 bytes) and `#k=…` (no `t`) all return `{ error: 'incomplete' }`.
  - `connection.test.ts` with a fake WebSocket:
    - the first message sent is a sealed `hello` (it decrypts to `{"t":"hello","token":…}`);
    - pings are sealed;
    - a sealed `ready` sets the phase to `live`;
    - a sealed frame reaches `onFrame`;
    - `code_required` calls `onCodeRequest(false)` and doesn't stop the connection;
    - `code_invalid` calls `onCodeRequest(true)`;
    - **the 60 s give-up window restarts after each successful `ready`:** two outages of 50 s each, with a `ready` between them, never reach `closed`.
  - `app.test.tsx`:
    - an incomplete link shows the text "This link is incomplete. Copy the whole link and open it again." and opens no socket;
    - the code prompt shows the label "Enter the 6-digit code", with an input that has `inputmode="numeric"` and `autocomplete="one-time-code"`; submitting sends `hello` with `code`;
    - "That code is not right." appears after `code_invalid`.

- [ ] **Step 2: Run** `pnpm --filter @unstuck/viewer test`. Expected: FAIL.

- [ ] **Step 3: Implement.** Keep the existing layout. The code prompt replaces the "connecting" state until accepted.

- [ ] **Step 4: Run** `pnpm --filter @unstuck/viewer test && pnpm --filter @unstuck/viewer build`. Expected: PASS, coverage ≥ 90%. Also `pnpm --filter @unstuck/engine test` (the embedded assets are regenerated).

- [ ] **Step 5: Commit** `feat(viewer): end-to-end encryption, code prompt, incomplete-link message`

### Task 5: Local end-to-end still works (gate)

**Files:** Modify `e2e/local-takeover.test.ts` only if selectors changed.

- [ ] **Step 1: Run** `pnpm --filter e2e test`. Expected: PASS. Embedded mode is now encrypted end to end through the real viewer and a real browser.
- [ ] **Step 2: Add** an assertion that one captured frame on the viewer's socket (`page.on('websocket')` → `framereceived`) has no JPEG magic `FF D8` within its first 64 bytes.
- [ ] **Step 3: Commit** `test(e2e): local takeover is end-to-end encrypted`

### Task 6: relay-core

**Files:**
- Create package `relay-core/` (AGPL): `package.json` (`@unstuck/relay-core`), `tsconfig.json`, `vitest.config.ts` (via `packageConfig()`), `LICENSE` (copy of `LICENSE-AGPL`), `src/index.ts`, `src/session.ts`, `src/hooks.ts`, `src/rate-limit.ts`, `src/keys.ts`
- Modify: `pnpm-workspace.yaml`, root `package.json` (`check:runtime` gains `relay-core/src`)
- Test: `relay-core/test/session.test.ts`, `relay-core/test/keys.test.ts`, `relay-core/test/rate-limit.test.ts`

**Interfaces:**
- Consumes: Task 1 relay types, envelope and `RELAY_LIMITS`.
- Produces:
  - `type Authorize` and `type RelayEvent`, exactly as in spec §5.5.
  - `type OnEvent = (e: RelayEvent) => void | Promise<void>`.
  - `interface RelaySocket { send(d: string | Uint8Array): void; close(code: number, reason?: string): void; readonly bufferedAmount: number }`
  - `interface SessionRecord { sessionId: string; account: string; keyHash: string; secretHash: string | null; expiresAt: number; createdAt: number; agentDownSince: number | null; nextC: number; billed: boolean; bytesToViewers: number; bytesToAgent: number; viewersSeen: number }`
  - `class RelaySession`, with:
    - `constructor(rec: SessionRecord, onEvent: OnEvent, now: () => number)`
    - `attachAgent(s: RelaySocket): void`
    - `agentMessage(d: string | Uint8Array): void`
    - `agentClosed(): void`
    - `attachViewer(s: RelaySocket): number | null`: returns `c`, or `null` when there's no live agent or 4 viewers are already attached
    - `viewerMessage(c: number, d: string | Uint8Array): void`
    - `viewerClosed(c: number): void`
    - `rebind(agent: RelaySocket | null, viewers: Map<number, RelaySocket>): void`: re-attaches sockets after Durable Object hibernation
    - `deadline(): number`: the next instant `tick` must run, `min(expiresAt, agentDownSince + graceMs, idle deadlines)`
    - `tick(): 'alive' | 'ended'`
    - `end(reason: string): void`
    - `get record(): SessionRecord`
    - `get ended(): boolean`
  - `createKeyAuthorizer(opts: { keys: string[] } | { open: true }): Authorize`: SHA-256 constant-time compare; account `'default'`; returns 401 `{ error: 'unauthorized' }`.
  - `createRateLimiter(limit: number, windowMs: number, now: () => number): { take(key: string): boolean; prune(): void; size(): number }`
  - `hashKey(key: string): Promise<string>` (hex SHA-256).

- [ ] **Step 1: Write the failing tests** in `session.test.ts`, with fake sockets and a fake clock.
  - **Registration:**
    - the agent's `hello` registers (`expiresAt` capped at now + 1 h);
    - a second `hello` on the same socket is ignored;
    - text before `hello` closes the agent socket with 1003;
    - `session_opened` fires once.
  - **Pairing and routing:**
    - with a viewer attached, the agent receives `{t:'open',c:1}`;
    - viewer bytes reach the agent as `encodeEnvelope(1, bytes)`, and the agent's `encodeEnvelope(1, x)` reaches viewer 1 as `x`;
    - an envelope for an unknown `c` is dropped;
    - text from a viewer closes it with 1003;
    - a viewer payload over 64 KB, or an agent payload over 2 MB, is dropped and closes that socket with 1009;
    - a 5th concurrent viewer gets `null`.
  - **Billing:**
    - `takeover_opened` fires on the first agent→viewer payload ≥ 4096 bytes, and only once even after a viewer reconnects and gets more;
    - **Review Focus 3:** two viewers each receiving frames counts once;
    - payloads of 4095 bytes never fire it.
  - **Backpressure:** with a viewer's `bufferedAmount` > 4 MB, payloads ≥ 4096 are dropped and smaller ones still delivered.
  - **Agent drop:**
    - viewers are closed with 1012, and `agentDownSince` is set;
    - reconnecting with the same secret (`attachAgent` + `hello` with the same secret) clears it;
    - a different secret is closed with 4409, and the original keeps working;
    - **Review Focus 4:** with no reconnect, `tick()` at grace + 1 ms returns `'ended'`, viewers are closed and `session_closed` fires once with byte counts.
  - **End and expiry:**
    - `end` from the agent closes everything and fires `session_closed`;
    - expiry ends the session.
  - **Idle:** a socket silent for 120 s is closed; a `ping` to the agent goes out every 30 s via `tick`.
  - **Other:**
    - `agent_event` passes through;
    - after `end`, every method is a no-op.

  `keys.test.ts` and `rate-limit.test.ts`:
  - a listed key gets `ok`, an unlisted key or `null` gets 401, and open mode allows `null`;
  - the limiter allows 30 then refuses the 31st within the window, and allows again after it; `prune` empties expired buckets.

- [ ] **Step 2: Run** `pnpm --filter @unstuck/relay-core test`. Expected: FAIL.

- [ ] **Step 3: Implement.** No timers inside `RelaySession`: hosts call `tick()` at `deadline()`, which keeps it host-agnostic and makes Durable Object alarms trivial.

- [ ] **Step 4: Run** `pnpm --filter @unstuck/relay-core test && pnpm check:runtime`. Expected: PASS, coverage ≥ 90%.

- [ ] **Step 5: Commit** `feat(relay-core): session pairing, limits, billing signal and hooks`

### Task 7: Core: relay transport (engine side)

**Files:**
- Create: `core/src/relay-transport.ts`; export it from `core/src/index.ts`
- Test: `core/test/relay-transport.test.ts` (fake `WebSocket` class injected; core must not depend on relay-core)

**Interfaces:**
- Consumes: Task 1 (`RELAY_SUBPROTOCOL`, envelope, control parsers); Task 2's `Transport` shape.
- Produces:
  - `createRelayTransport(opts: { url: string; agentKey?: string; WebSocketImpl?: typeof WebSocket; connectTimeoutMs?: number /* 15_000 */ }): Transport & { onStatus(id, h): void }`
  - `class RelayError extends Error { detail: 'relay_unauthorized' | 'relay_quota_exceeded' | 'relay_rate_limited' | 'relay_unreachable' }`

- [ ] **Step 1: Write the failing tests:**
  - **Publish:**
    - `publish('S…', {expiresAt})` opens `wss://r.test/agent/S…` with protocols `['unstuck-relay.1', 'key.K']`, sends `hello` with `expiresAt` and a 22-character base64url `secret`, and resolves `{ baseUrl: 'https://r.test/s/S…' }` (`ws://` maps to `http://`);
    - with no key, only `['unstuck-relay.1']` is offered.
  - **Viewer connections:**
    - relay `open` c=3 calls the `onConnection` handler with a `ViewerConnection`; its `send(x)` emits `encodeEnvelope(3, x)`;
    - an inbound envelope for c=3 reaches `onMessage`;
    - relay `close` c=3 fires `onClose`;
    - `conn.close(1008)` sends `{t:'close',c:3,code:1008}`.
  - **Control:** `ping` is answered with `pong`; `unpublish` sends `end` and closes the socket.
  - **Errors:**
    - a socket that closes before opening, with the fake reporting an HTTP status of 401, 402 or 429, rejects `publish` with `RelayError` details `relay_unauthorized`, `relay_quota_exceeded` and `relay_rate_limited` respectively;
    - no open within 15 s rejects with `relay_unreachable`.
  - **Review Focus 1:** after a drop with an open session, the transport reports `down`, retries at 0.5, 1, 2… s (cap 30 s) with the **same secret**, then reports `up`; existing connections were closed, and new `open`s work.
  - **In-process path:** `createEngine({ transport: createRelayTransport(...) })` runs a full takeover with `FakeCdp` and `FakeViewer` through the fake relay.

  How the fake reports an HTTP status: browsers don't expose upgrade statuses, so the relay also closes with a numeric close code (4401, 4402, 4429) when it refuses after accepting. Both hosts use that path (Tasks 8 and 9), and the transport maps 4401/4403 → `relay_unauthorized`, 4402 → `relay_quota_exceeded`, 4429 → `relay_rate_limited`.

- [ ] **Step 2: Run** `pnpm --filter @unstuck/core test`. Expected: FAIL.

- [ ] **Step 3: Implement.** One agent socket per published session; viewer connections are keyed by `c`.

- [ ] **Step 4: Run** `pnpm --filter @unstuck/core test && pnpm check:runtime`. Expected: PASS.

- [ ] **Step 5: Commit** `feat(core): relay transport`

**Ruling carried into the spec:** a refused agent upgrade is *accepted* and then closed with `4000 + HTTP status` (4401, 4402, 4403, 4429), because WebSocket clients can't read an upgrade's HTTP status. The `{error}` JSON goes in the close reason. Update spec §5.5 step 1 and §5.7 in this task's commit.

### Task 8: relay-node and the Docker image

**Files:**
- Create package `relay-node/` (AGPL): `package.json` (`@unstuck/relay`, bin `unstuck-relay`), `src/server.ts`, `src/cli.ts`, `src/bin.ts`, `Dockerfile`, `.dockerignore`, `README.md`, `LICENSE`
- Test: `relay-node/test/server.test.ts`, `relay-node/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 6 `RelaySession`, `createKeyAuthorizer`, `createRateLimiter`, `hashKey`; Task 7 `createRelayTransport`, used in tests to drive real sessions.
- Produces:
  - `createNodeRelay(opts: { port?: number; host?: string; viewerDir: string; authorize?: Authorize; onEvent?: OnEvent; now?: () => number; sweepMs?: number /* 60_000 */ }): Promise<{ port: number; close(): Promise<void>; stats(): { sessions: number; limiterBuckets: number } }>`
  - CLI `unstuck-relay [--port 8787] [--host 0.0.0.0]`, configured by environment:
    - `UNSTUCK_AGENT_KEYS` (comma-separated);
    - `UNSTUCK_RELAY_OPEN=1`, which prints the warning `relay is OPEN: anyone can register sessions` at start and on each agent connection;
    - `PORT`.

    With neither keys nor open mode set, it exits with code 2 and a message naming both variables.

- [ ] **Step 1: Write the failing tests** with real `ws` and the real viewer build (`viewer/dist`).
  - **HTTP:**
    - `GET /healthz` → `{ok:true}`;
    - `GET /s/<live id>` → 200 with headers `cache-control: no-store`, `referrer-policy: no-referrer` and the CSP;
    - an unknown id → 404 with the expired page;
    - `/assets/*` served;
    - a bad id format → 404.
  - **Agent upgrade:**
    - a wrong key → closed 4401;
    - 21 agent upgrades in a minute with one key → the 21st is closed 4429;
    - a different key for a live id → 4409.
  - **Viewer upgrade:**
    - a viewer upgrade to an id with no agent → 404;
    - 31 viewer upgrades from one IP → the 31st refused.
  - **Full flow:** `createRelayTransport` + `createEngine` + `FakeCdp` + a ws viewer client sealing with the link key reaches `resolved`; `onEvent` saw `session_opened`, `takeover_opened` and `session_closed`.
  - **Security:** every binary frame the relay forwarded, captured in `onEvent`-adjacent test instrumentation (a socket spy), contains no `FF D8`, no `"hello"` and no token text.
  - **Review Focus 1 (Node half):** killing the agent's socket mid-takeover, then letting it reconnect, gives `resolved` in the end.
  - **Review Focus 4:** the agent socket is destroyed with no `end`; after 60 s (fake clock driving the sweep) the viewer is closed and `stats().sessions === 0`.
  - **Shutdown:** `close()` closes sockets with 1001 within 5 s.
  - `cli.test.ts`: missing config → exit 2; open mode prints the warning.

- [ ] **Step 2: Run** `pnpm --filter @unstuck/relay test`. Expected: FAIL.

- [ ] **Step 3: Implement.** One `setInterval(sweepMs)` calls `tick()` on every session and `prune()` on the limiters. The client IP is `x-forwarded-for`'s first entry when `UNSTUCK_TRUST_PROXY=1`, otherwise the socket address. The Dockerfile is multi-stage: build the viewer, then a `node:22-alpine` runtime running as a non-root user, `EXPOSE 8787`, `HEALTHCHECK` on `/healthz`.

- [ ] **Step 4: Run** `pnpm --filter @unstuck/relay test`, then `docker build -f relay-node/Dockerfile -t unstuck-relay:test .` and `docker run -d -p 18787:8787 -e UNSTUCK_RELAY_OPEN=1 unstuck-relay:test`, then `curl -s localhost:18787/healthz`. Expected: PASS, coverage ≥ 90%, `{"ok":true}`. If Docker isn't available in the environment, record that in the ledger and run the image check in Task 11's final pass instead.

- [ ] **Step 5: Commit** `feat(relay-node): Node relay, CLI and Docker image`

### Task 9: relay-cloudflare

**Files:**
- Create package `relay-cloudflare/` (AGPL): `package.json` (`@unstuck/relay-cloudflare`; devDependencies `wrangler@4`, `vitest@4`, `@vitest/coverage-istanbul@4`, `@cloudflare/vitest-plugin`, `@cloudflare/workers-types`), `src/worker.ts`, `src/durable-object.ts`, `src/index.ts` (default self-host entry), `wrangler.toml` (template), `vitest.config.ts` (Istanbul, 90% thresholds), `scripts/copy-viewer.mjs`, `README.md`, `LICENSE`
- Test: `relay-cloudflare/test/worker.test.ts`, `relay-cloudflare/test/durable-object.test.ts`

**Interfaces:**
- Consumes: Task 6 (everything); Task 1 constants.
- Produces:
  - `createRelayWorker<E extends RelayEnv>(opts?: { authorize?: (key: string | null, ctx: { sessionId: string; ip: string }, env: E) => ReturnType<Authorize>; onEvent?: (e: RelayEvent, env: E) => void | Promise<void> }): { fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response>; RelaySessionDO: DurableObjectClass }`
  - `interface RelayEnv { RELAY_SESSION: DurableObjectNamespace; ASSETS: Fetcher; AGENT_KEYS?: string; RELAY_OPEN?: string; VIEWER_LIMIT?: RateLimit; AGENT_LIMIT?: RateLimit }`
  - The default `src/index.ts` exports `createRelayWorker()` as `default` and `RelaySessionDO`.

  This is the entry Unstuck Cloud imports in Plan C2b, so it's the only public API of this package.

- [ ] **Step 1: Write the failing tests** under `@cloudflare/vitest-plugin`.
  - **Worker:**
    - `/healthz`;
    - `/s/<id>` is 404 until an agent registers, then 200 with headers `cache-control: no-store` and `referrer-policy: no-referrer`;
    - agent upgrade with a bad key → accepted then closed 4401;
    - rate-limit binding refusing → 4429;
    - the response echoes `sec-websocket-protocol: unstuck-relay.1` only;
    - routing uses `idFromName(<id>)`.
  - **Durable Object:**
    - pairing and forwarding through `RelaySession` with hibernatable sockets tagged `agent` and `v:<c>`;
    - after a simulated hibernation (new object instance, same storage plus `getWebSockets()`), forwarding still works: `rebind` from tags and storage;
    - the alarm is set to `deadline()` after each change.
  - **Review Focus 4:** with no `end`, running the alarm past grace leaves `storage.list()` empty and `getAlarm()` `null`. An `end` from the agent gives the same result.
  - **Hooks:** `onEvent` receives `takeover_opened` once; a custom `authorize` returning 402 closes the agent with 4402.

- [ ] **Step 2: Run** `pnpm --filter @unstuck/relay-cloudflare test`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - The Durable Object persists `SessionRecord` with `storage.put('rec', …)` on every state change and runs housekeeping per spec §5.9 (`deleteAll()` + `deleteAlarm()` on end).
  - The Worker authorizes and rate-limits before `stub.fetch`, and passes `account` in an internal header that the object trusts only from the Worker (strip it from incoming requests).
  - `copy-viewer.mjs` copies `viewer/dist` into `relay-cloudflare/public` before `wrangler dev`/`deploy` and tests.

- [ ] **Step 4: Run** `pnpm --filter @unstuck/relay-cloudflare test` and `pnpm --filter @unstuck/relay-cloudflare exec wrangler deploy --dry-run`. Expected: PASS, coverage ≥ 90%, dry run builds.

- [ ] **Step 5: Commit** `feat(relay-cloudflare): Worker and per-takeover Durable Object relay`

### Task 10: Engine, SDKs and MCP choose the relay

**Files:**
- Create: `engine/src/transport-select.ts`
- Modify: `engine/src/cli.ts`, `engine/src/stdio-host.ts`, `engine/src/mcp.ts`, `sdk-ts/src/unstuck.ts`, `sdk-ts/src/engine-process.ts`, `sdk-py/src/unstuck/_client.py`, `sdk-py/src/unstuck/_engine.py`, `sdk-py/src/unstuck/_types.py` (or wherever `TakeoverLink` lives)
- Test: `engine/test/transport-select.test.ts`, `engine/test/cli.test.ts`, `sdk-ts/test/unstuck.test.ts`, `sdk-py/tests/test_client.py`

**Interfaces:**
- Consumes: Task 7 `createRelayTransport`, `RelayError`; Task 3 `requireCode`, `LinkInfo.code`.
- Produces:
  - `selectTransport(flags: { relay?: string; agentKey?: string }, env: Record<string, string | undefined>): { kind: 'relay'; url: string; agentKey?: string; source: 'flag' | 'UNSTUCK_RELAY_URL' | 'UNSTUCK_API_KEY' } | { kind: 'embedded' }`
  - **CLI:**
    - flags `--relay <url>` and `--agent-key <key>`;
    - startup line `[unstuck] engine <v>; relay <url>` (never the key) or the existing embedded line;
    - `UNSTUCK_REQUIRE_CODE=1` sets the engine default.
  - **TS SDK:** `UnstuckOptions.relay?: string`, `agentKey?: string`, `requireCode?: boolean`; `takeover(page, { reason, requireCode? })`; `TakeoverLink.code?: string`. `spawnEngine` passes `UNSTUCK_RELAY_URL` and `UNSTUCK_AGENT_KEY` in the child's environment (merged over `process.env`) and `requireCode` in `TakeoverParams`.
  - **Python:** `Unstuck(relay=..., agent_key=..., require_code=...)`, `takeover(page, reason=..., require_code=...)`, and `TakeoverLink.code: str | None`.
  - **Errors:** a `RelayError` at publish becomes a `failed` result with its `detail`. When the source was `UNSTUCK_API_KEY` and the detail is `relay_unauthorized`, stderr also prints `[unstuck] unstuck.sh rejected UNSTUCK_API_KEY: check the key in your dashboard`.

- [ ] **Step 1: Write the failing tests.**
  - **`selectTransport`:** the order is flag > `UNSTUCK_RELAY_URL` > `UNSTUCK_API_KEY` (→ `wss://unstuck.sh`, or `UNSTUCK_CLOUD_URL`) > embedded.
  - **CLI:** the CLI startup line in relay mode doesn't contain the key.
  - **Review Focus 5:** an engine with `UNSTUCK_API_KEY=uk_live_bad…` against a relay-core fake that closes 4401 returns `failed`/`relay_unauthorized` in under 5 s, and stderr contains `UNSTUCK_API_KEY`.
  - **MCP:** the tool result carries `detail: relay_quota_exceeded` on a 4402.
  - **TS SDK:** the spawned environment contains `UNSTUCK_RELAY_URL`/`UNSTUCK_AGENT_KEY` when the options are set, and `onLink` receives `code`.
  - **Python:** the same two checks.

- [ ] **Step 2: Run** `pnpm --filter @unstuck/engine test && pnpm --filter unstuck test && pnpm test:py`. Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** the same command. Expected: PASS, coverage ≥ 90% in all three. Rebuild the engine binary (`pnpm --filter @unstuck/engine build`).

- [ ] **Step 5: Commit** `feat: relay mode in the engine, SDKs and MCP`

### Task 11: End-to-end matrix, docs, final gate

**Files:**
- Create: `e2e/relay.test.ts`, `e2e/relay-harness.ts`
- Modify: `README.md` (relay and self-hosting section), `relay-node/README.md`, `relay-cloudflare/README.md`, `docs/superpowers/specs/2026-11-12-relay-design.md` (Task 7 ruling, if not already done)

**Interfaces:**
- Consumes: everything above.
- Produces: `startRelay(kind: 'node' | 'cloudflare'): Promise<{ url: string; stop(): Promise<void> }>` in `relay-harness.ts`. Cloudflare runs `wrangler dev --port 0` in `relay-cloudflare` and waits for `/healthz`.

- [ ] **Step 1: Write** `e2e/relay.test.ts`, with Playwright: an agent browser on the fake CAPTCHA fixture, and a human browser (390×844) opening the link. Matrix:
  - TS SDK × node relay;
  - TS SDK × cloudflare relay;
  - Python SDK × node relay;
  - MCP (`unstuck-engine --mcp` with `UNSTUCK_RELAY_URL`) × node relay;
  - in-process `createEngine` + `createRelayTransport` × cloudflare relay.

  Each solves the fixture and expects `resolved`. Add the six-digit code case once (TS × node): the human enters the code from `onLink`.

- [ ] **Step 2: Run** `pnpm --filter e2e test`. Expected: PASS, run twice with no flakes.

- [ ] **Step 3: Docs.** Update the READMEs:
  - **Root `README.md`:** relay mode in three lines (`UNSTUCK_API_KEY` for Cloud; `UNSTUCK_RELAY_URL` + `UNSTUCK_AGENT_KEY` for self-hosted; nothing for local).
  - **`relay-node/README.md`:** Docker run, environment variables and the open-mode warning.
  - **`relay-cloudflare/README.md`:**
    - `wrangler deploy` steps;
    - the `AGENT_KEYS` secret via `wrangler secret put`;
    - the optional rate-limit bindings;
    - how a host imports `createRelayWorker` with its own `authorize`/`onEvent`.

- [ ] **Step 4: Final gate.** Run each in order. Expected: all PASS, every package ≥ 90%, and the Docker health check returns `{"ok":true}`.
  1. `pnpm test`
  2. `pnpm check:runtime`
  3. `pnpm -r build`
  4. `pnpm --filter e2e test`
  5. the Docker image check from Task 8, if it was deferred

- [ ] **Step 5: Commit** `test(e2e): relay matrix; docs: relay and self-hosting`
