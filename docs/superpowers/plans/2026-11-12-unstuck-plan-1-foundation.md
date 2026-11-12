# Unstuck Plan 1: Spikes + Foundation (local takeover) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript agent calls `unstuck.takeover(page, { reason })`, a human opens the printed localhost link, sees the live page, clicks and types into it, taps **Done**, and the call resolves `resolved`.

**Architecture:** A runtime-agnostic `@unstuck/core` (web-standard APIs only) holds the session state machine, tokens, screencast and input. `@unstuck/engine` hosts core in Node. It talks to the SDK over JSON-lines stdio, tunnels CDP through the SDK's own CDP session, and serves the viewer from an embedded HTTP/WebSocket server on 127.0.0.1. `unstuck` (the TypeScript SDK) spawns the compiled engine binary and pipes CDP.

**Tech Stack:** Node 22, TypeScript 5, pnpm 10 workspaces, Vitest, TypeBox (schemas + JSON Schema export), `ws`, Preact + Vite (viewer), Bun `--compile` (engine binary), Playwright (pre-installed, for e2e).

**Spec:** `docs/superpowers/specs/2026-11-12-unstuck-mvp-design.md`

## Global Constraints

- Product name **Unstuck**. npm packages: `unstuck` (TS SDK), `@unstuck/protocol`, `@unstuck/core`, `@unstuck/engine`, `@unstuck/viewer`. Engine binary: `unstuck-engine`. Env var prefix: `UNSTUCK_`.
- Licenses: Apache-2.0 for `protocol/`, `core/`, `engine/`, `sdk-ts/`; AGPL-3.0 for `viewer/`. Each package has its own `LICENSE` file and `"license"` field.
- `protocol/`, `core/`, `viewer/` must not import Node built-ins (`node:*` or any name in `module.builtinModules`). This is enforced by `scripts/check-runtime-agnostic.mjs` in CI.
- Default takeover timeout **600 s**. Embedded server binds **127.0.0.1** by default; any other host prints a warning to stderr.
- Session IDs: **128-bit** random, base64url. Token and resume key travel in the URL **fragment** (`#t=…`), never in a path or query.
- Single viewer per session, token single-use; same-device resume allowed for **60 s** after disconnect.
- Frames: **binary** WebSocket messages, newest-frame-only (never queue more than one pending frame per viewer).
- Event log: never contains screenshots, key/text content or secrets, only counts.
- Engine stdout is reserved for the JSON-lines protocol; all engine logging goes to stderr.
- Protocol version: **1** (exchanged in `engine.hello`).

## Review Focus

1. **Human's screen is a different size or shape than the agent's page** (phone portrait vs 1280×720 desktop, high-DPI display): clicks must land where the human tapped, letterboxed areas must be ignored. → Task 9 unit tests, Task 12 e2e at 390×844.
2. **A second person opens the same link, or the link is reopened after use:** they get a clear "already in use" screen and the first human's session is unaffected. → Task 6 test, Task 12 e2e.
3. **The agent's page closes or crashes mid-takeover:** `takeover()` returns `failed` with detail `page_closed` within a second; never hangs until timeout. → Task 6 test, Task 11 test.
4. **Engine binary missing, not executable, or crashes:** the SDK throws `UnstuckEngineError` naming the path it tried and `UNSTUCK_ENGINE_PATH`, instead of hanging; the next call respawns. → Task 11 tests.
5. **Nobody joins before the timeout:** result is `timed_out`, the screencast is stopped, the session unpublished, and the agent process can exit normally afterwards (no dangling server, timer or child process). → Task 6 test, Task 11 test.

---

## File map

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.workspace.ts, .gitignore
scripts/check-runtime-agnostic.mjs
docs/spikes/{obscura.md, cloudflare-browser-rendering.md}
spikes/{obscura,cloudflare}/probe.mjs           throwaway probe scripts
protocol/src/{rpc-types.ts, viewer.ts, frame.ts, rpc.ts, result.ts, index.ts}, protocol/scripts/export-schemas.ts
core/src/cdp.ts                    CdpClient interface
core/src/session/{status.ts, tokens.ts, takeover.ts}
core/src/stream/{screencast.ts, input.ts, latest.ts}
core/src/events.ts                 EventLog interface + MemoryEventLog
core/src/transport.ts              Transport / ViewerConnection interfaces
core/src/engine.ts                 createEngine()
engine/src/{tunnel.ts, stdio-host.ts, embedded.ts, assets.gen.ts, jsonl-log.ts, cli.ts}, engine/scripts/{embed-viewer.mjs, build-binary.mjs}
viewer/src/{main.tsx, App.tsx, mapping.ts, keys.ts, connection.ts, styles.css}, viewer/index.html, viewer/vite.config.ts
sdk-ts/src/{index.ts, unstuck.ts, engine-process.ts, attach.ts, errors.ts}
e2e/{fixtures/fake-captcha.html, local-takeover.test.ts}
```

---

### Task 1: Spike: Obscura compatibility

Throwaway. The output is `docs/spikes/obscura.md`, not product code.

**Files:**
- Create: `spikes/obscura/probe.mjs`, `docs/spikes/obscura.md`

- [ ] **Step 1: Start Obscura.** `docker run -d --name obscura -p 9222:9222 <image from the Obscura README> serve --port 9222` (or download the release archive with rendering). If no image or binary can be fetched, record "blocked: <reason>" in the doc and skip to Step 4.
- [ ] **Step 2: Write `spikes/obscura/probe.mjs`.** Connect with `chromium.connectOverCDP('ws://127.0.0.1:9222')`, open a CDP session, and record pass/fail plus the error text for each of: `Page.startScreencast` (got ≥1 `Page.screencastFrame` within 5 s), `Page.captureScreenshot`, `Input.dispatchMouseEvent` (click changes a counter on a `data:` page), `Input.dispatchKeyEvent`, `Input.insertText`, `Runtime.evaluate`, `Target.setAutoAttach` reporting a cross-origin iframe (load a page with `<iframe src="https://example.com">`), and `Target.targetCreated` on `window.open`. Then load the official test pages for reCAPTCHA v2 (`https://www.google.com/recaptcha/api2/demo`), hCaptcha (`https://accounts.hcaptcha.com/demo`) and Turnstile (`https://challenges.cloudflare.com/turnstile/v0/api.js` on a demo page with the always-pass test sitekey `1x00000000000000000000AA`) and save a screenshot of each.
- [ ] **Step 3: Run it.** `node spikes/obscura/probe.mjs > docs/spikes/obscura-raw.json`. Expected: a JSON object with one entry per capability.
- [ ] **Step 4: Write `docs/spikes/obscura.md`** with the capability table, the screenshots' verdict (widget rendered correctly: yes/no), and a recommendation: stays Tier 2 / downgrade / unsupported. List the fallbacks needed (spec §4.4).
- [ ] **Step 5: Commit.** `git add spikes/obscura docs/spikes && git commit -m "spike: Obscura CDP compatibility"`

### Task 2: Spike: Cloudflare Browser Rendering

Throwaway. The output is `docs/spikes/cloudflare-browser-rendering.md`.

**Files:**
- Create: `spikes/cloudflare/{wrangler.toml, src/index.ts}`, `docs/spikes/cloudflare-browser-rendering.md`

- [ ] **Step 1: Check access.** Needs a Cloudflare account with Browser Rendering and `CLOUDFLARE_API_TOKEN`. If unavailable, write the doc with "blocked: needs Cloudflare account", state the screenshot-polling fallback (spec §14 risk 1) as the working assumption, commit, and stop this task.
- [ ] **Step 2: Write a Worker** using `@cloudflare/puppeteer`: launch, `page.createCDPSession()`, then test `Page.startScreencast` (≥1 frame in 5 s), `Page.captureScreenshot`, `Input.dispatchMouseEvent`, `Input.insertText`. Return the results as JSON.
- [ ] **Step 3: Run it.** `npx wrangler dev --remote` and `curl` the Worker. Expected: a JSON capability report.
- [ ] **Step 4: Write the doc** with the results, measured frame rate, and a recommendation (screencast vs screenshot polling) for Plan 5.
- [ ] **Step 5: Commit.** `git commit -m "spike: Cloudflare Browser Rendering CDP support"`

### Task 3: Monorepo scaffold + protocol package

**Files:**
- Create: root `package.json` (private, `"packageManager": "pnpm@10"`, scripts `build`, `test`, `check:runtime`), `pnpm-workspace.yaml` (`protocol`, `core`, `engine`, `viewer`, `sdk-ts`, `e2e`), `tsconfig.base.json` (strict, `ES2022`, `moduleResolution: bundler`), `vitest.workspace.ts`, `.gitignore` (`node_modules`, `dist`, `*.gen.ts`, `protocol/schemas/`, `docs/spikes/*-raw.json`)
- Create: `scripts/check-runtime-agnostic.mjs`, `scripts/check-runtime-agnostic.test.mjs`
- Create: `protocol/{package.json, LICENSE (Apache-2.0), tsconfig.json}`, `protocol/src/*.ts` (listed below), `protocol/scripts/export-schemas.ts`, `protocol/test/*.test.ts`
- Create: `LICENSE-APACHE`, `LICENSE-AGPL` at root (fetch from `https://www.apache.org/licenses/LICENSE-2.0.txt` and `https://www.gnu.org/licenses/agpl-3.0.txt`), root `README.md` (one paragraph + "work in progress")

**Interfaces:**
- Produces (`@unstuck/protocol`):
  - `PROTOCOL_VERSION = 1`
  - `rpc-types.ts`: `RpcRequest {id:number; method:string; params?:unknown}`, `RpcResponse {id:number; result?:unknown; error?:{code:string; message:string}}`, `RpcNotification {method:string; params?:unknown}`
  - `rpc.ts`: `createRpcPeer(write: (line: string) => void): RpcPeer`, where `RpcPeer = { request<T>(method, params?): Promise<T>; notify(method, params?): void; handle(method, fn: (params) => Promise<unknown> | unknown): void; onNotification(method, fn: (params) => void): void; receive(line: string): void; close(reason: string): void }`. `close` rejects all pending requests with `Error(reason)`; a handler that throws becomes `error:{code:'handler_error', message}`; an unknown method becomes `error:{code:'unknown_method'}`.
  - Method names (string constants exported as `Methods`): SDK→engine requests `engine.hello {sdk:'ts'|'py'; sdkVersion:string; protocolVersion:number} → {engineVersion:string; protocolVersion:number}`, `takeover {pageId:string; reason:string; timeoutS?:number; site?:string} → TakeoverResult`, `shutdown {} → {}`. Engine→SDK requests `cdp.send {pageId; method; params?} → unknown`, `cdp.subscribe {pageId; events:string[]} → {}`. Notifications: SDK→engine `cdp.event {pageId; method; params}`, `cdp.closed {pageId; reason}`; engine→SDK `takeover.link {sessionId; pageId; url; reason; expiresAt:number}`.
  - `result.ts`: `TakeoverStatus = 'resolved'|'timed_out'|'cancelled'|'failed'`, `TakeoverResult {status; sessionId:string; url:string; durationS:number; detail?:string}`
  - `viewer.ts`: TypeBox schemas + types `ViewerToEngine` = `{t:'hello'; token:string; resumeKey?:string}` | `{t:'mouse'; action:'down'|'up'|'move'; x:number; y:number; button:'left'|'right'|'middle'|'none'; clickCount:number; modifiers:number}` | `{t:'wheel'; x; y; dx:number; dy:number}` | `{t:'key'; action:'down'|'up'; key:string; code:string; text?:string; modifiers:number}` | `{t:'text'; text:string}` | `{t:'done'}` | `{t:'cant_solve'; reason?:string}` | `{t:'ping'}`; `EngineToViewer` = `{t:'ready'; reason:string; site:string; expiresAt:number; resumeKey:string}` | `{t:'state'; status:SessionStatus}` | `{t:'error'; code:'token_invalid'|'token_used'|'expired'|'session_closed'|'bad_message'; message:string}` | `{t:'pong'}`; `parseViewerMessage(raw: string): ViewerToEngine | null` (validates with TypeBox `Value.Check`). `SessionStatus` = the 8 states from spec §6.
  - `frame.ts`: `encodeFrame(f: {width:number; height:number; jpeg:Uint8Array}): Uint8Array` (byte 0 = `0x01`, bytes 1–2 width u16 BE, bytes 3–4 height u16 BE, rest JPEG; width/height are **page CSS pixels**), `decodeFrame(b: Uint8Array): {width; height; jpeg} | null`
  - `export-schemas.ts` writes `protocol/schemas/*.json` (for the Python SDK in Plan 2).

- [ ] **Step 1: Write failing tests.**
  - `scripts/check-runtime-agnostic.test.mjs`: running the checker on a temp dir containing `import fs from 'node:fs'` exits 1 and prints the file and specifier; on `import x from 'fs'` exits 1; on `import { a } from './a'` exits 0.
  - `protocol/test/frame.test.ts`: `decodeFrame(encodeFrame({width:1280,height:720,jpeg:new Uint8Array([9,8,7])}))` deep-equals the input; `decodeFrame(new Uint8Array([2,0,0,0,0]))` is `null`; byte 0 of an encoded frame is `1`.
  - `protocol/test/rpc.test.ts`: two peers wired to each other: `a.request('x',{n:1})` resolves with what `b.handle('x', p => p.n+1)` returns (`2`); unknown method rejects with code `unknown_method`; handler throw rejects with code `handler_error`; `a.close('gone')` rejects a pending request with message `gone`; notifications reach `onNotification`.
  - `protocol/test/viewer.test.ts`: `parseViewerMessage('{"t":"mouse","action":"down","x":1,"y":2,"button":"left","clickCount":1,"modifiers":0}')` returns the object; `'{"t":"mouse"}'`, `'not json'` and `'{"t":"eval","code":"x"}'` return `null`.
- [ ] **Step 2: Run them.** `pnpm -r test` and `node --test scripts/`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the checker (walk `protocol/src core/src viewer/src`, regex static and dynamic import specifiers, compare against `node:` prefix and `module.builtinModules`) and the protocol modules with the signatures above.
- [ ] **Step 4: Run them.** Same commands. Expected: PASS. `pnpm --filter @unstuck/protocol run export-schemas` creates `protocol/schemas/viewer-to-engine.json` etc.
- [ ] **Step 5: Commit.** `git commit -m "feat(protocol): workspace scaffold, RPC peer, viewer messages, frame codec"`

### Task 4: core: tokens and session status machine

**Files:**
- Create: `core/{package.json, LICENSE (Apache-2.0), tsconfig.json}`, `core/src/session/tokens.ts`, `core/src/session/status.ts`, `core/test/tokens.test.ts`, `core/test/status.test.ts`

**Interfaces:**
- Produces:
  - `newSessionId(): string` (16 bytes from `crypto.getRandomValues`, base64url, 22 chars)
  - `newSecret(): Uint8Array` (32 bytes); `importSecret(raw: Uint8Array): Promise<CryptoKey>` (HMAC-SHA-256)
  - `signToken(key: CryptoKey, sessionId: string, expiresAtMs: number): Promise<string>`, giving `base64url("${sessionId}.${expiresAtMs}") + "." + base64url(hmac)`
  - `verifyToken(key: CryptoKey, token: string, nowMs: number): Promise<{ok:true; sessionId:string; expiresAtMs:number} | {ok:false; code:'token_invalid'|'expired'}>` (constant-time compare of the MAC)
  - `SessionEvent = 'published'|'notified'|'viewer_joined'|'viewer_left'|'done'|'cant_solve'|'timeout'|'cancel'|'error'`
  - `nextStatus(current: SessionStatus, event: SessionEvent): SessionStatus`; throws `InvalidTransitionError` for transitions not in spec §6. Terminal states (`resolved`, `timed_out`, `cancelled`, `failed`) accept no events. `timeout`/`cancel`/`error` are valid from any non-terminal state.

- [ ] **Step 1: Write failing tests.**
  - tokens: a signed token verifies `ok` with the same sessionId before expiry; at `nowMs === expiresAtMs` returns `expired`; flipping any character of the MAC part returns `token_invalid`; a token signed with another secret returns `token_invalid`; `newSessionId()` matches `/^[A-Za-z0-9_-]{22}$/` and 1,000 calls are unique.
  - status: `created→published→notifying`, `notifying→notified→waiting`, `waiting→viewer_joined→active`, `active→viewer_left→waiting`, `active→done→resolved`, `active→cant_solve→cancelled`, `waiting→timeout→timed_out`, `created→error→failed`; `nextStatus('resolved','done')` throws `InvalidTransitionError`; `nextStatus('waiting','done')` throws.
- [ ] **Step 2: Run them.** `pnpm --filter @unstuck/core test`. Expected: FAIL.
- [ ] **Step 3: Implement** with `crypto.subtle` only (no `node:crypto`).
- [ ] **Step 4: Run them.** Same command, plus `node scripts/check-runtime-agnostic.mjs`. Expected: PASS, checker exit 0.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): session tokens and status machine"`

### Task 5: core: CDP interface, screencast, input, latest-frame sender, event log

**Files:**
- Create: `core/src/cdp.ts`, `core/src/stream/{screencast.ts, input.ts, latest.ts}`, `core/src/events.ts`, `core/src/testing/fake-cdp.ts` (exported as `@unstuck/core/testing` via the package `exports` map, so the engine and SDK tests can reuse it), `core/test/{screencast,input,latest,events}.test.ts`

**Interfaces:**
- Produces:
  - `interface CdpClient { send<T = unknown>(method: string, params?: object): Promise<T>; on(event: string, handler: (params: any) => void): () => void; onClose(handler: (reason: string) => void): () => void }`
  - `startScreencast(cdp: CdpClient, onFrame: (f: {width:number; height:number; jpeg:Uint8Array}) => void, opts?: {quality?: number; maxWidth?: number; maxHeight?: number}): Promise<() => Promise<void>>`. Defaults: quality **70**, maxWidth **1600**, maxHeight **1600**. Width/height come from `metadata.deviceWidth/deviceHeight`. Ack every frame (`Page.screencastFrameAck`) immediately. The returned function calls `Page.stopScreencast` and removes the listener.
  - `applyInput(cdp: CdpClient, msg: Extract<ViewerToEngine, {t:'mouse'|'wheel'|'key'|'text'}>): Promise<void>`. Mapping: mouse `down/up/move` → `Input.dispatchMouseEvent` type `mousePressed/mouseReleased/mouseMoved` with `x, y, button, clickCount, modifiers`; wheel → `mouseWheel` with `deltaX: dx, deltaY: dy`; key down with `text` → `keyDown` (`text`, `unmodifiedText`), key down without `text` → `rawKeyDown`, key up → `keyUp`, all carrying `key, code, modifiers`, and `windowsVirtualKeyCode` from a small table for Enter(13), Backspace(8), Tab(9), Escape(27), arrows(37–40), Delete(46); text → `Input.insertText`.
  - `createLatestSender(conn: {send(b: Uint8Array): void; readonly bufferedAmount: number}, opts?: {highWaterMark?: number}): {push(frame: Uint8Array): void; drain(): void}`. Default highWaterMark **512 KiB**. `push` sends immediately if `bufferedAmount < highWaterMark`, else replaces the single pending frame. `drain()` (called on a timer by the session) sends the pending frame once below the mark.
  - `interface EventLog { append(e: UnstuckEvent): void }`; `UnstuckEvent {ts:number; sessionId:string; type:'created'|'published'|'link'|'viewer_joined'|'viewer_left'|'viewer_rejected'|'status'|'finished'; data?: Record<string, string|number|boolean>}`; `class MemoryEventLog implements EventLog { events: UnstuckEvent[] }`
  - `@unstuck/core/testing`: `FakeCdp implements CdpClient` recording `calls: {method, params}[]`, with `emit(event, params)`, `close(reason)` and `respond(method, fn)`.

- [ ] **Step 1: Write failing tests.**
  - screencast: after `startScreencast`, `FakeCdp.calls` contains `Page.startScreencast` with `{format:'jpeg', quality:70, maxWidth:1600, maxHeight:1600}`; emitting `Page.screencastFrame {data:'AQID', sessionId:7, metadata:{deviceWidth:1280, deviceHeight:720}}` calls `onFrame` with `{width:1280, height:720, jpeg:Uint8Array[1,2,3]}` and records `Page.screencastFrameAck {sessionId:7}`; calling stop records `Page.stopScreencast` and later frames don't reach `onFrame`.
  - input: one test per mapping row above, asserting exact `method` and params; `{t:'text', text:'héllo 日本'}` → `Input.insertText {text:'héllo 日本'}`; key `Enter` down with text `'\r'` carries `windowsVirtualKeyCode:13`.
  - latest: with `bufferedAmount` 0, three pushes send three frames; with `bufferedAmount` above the mark, pushes A, B, C send nothing, and after the fake drops below the mark `drain()` sends only C.
  - events: `MemoryEventLog` keeps order.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Base64 decode with `atob` (web API).
- [ ] **Step 4: Run them.** Expected: PASS, runtime checker exit 0.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): screencast, input mapping, latest-frame sender, event log"`

### Task 6: core: transport interface and the takeover session (engine)

**Files:**
- Create: `core/src/transport.ts`, `core/src/session/takeover.ts`, `core/src/engine.ts`, `core/src/index.ts` (re-exports), `core/src/testing/fake-transport.ts` (`FakeTransport`, added to `@unstuck/core/testing`), `core/test/takeover.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  - `interface ViewerConnection { send(data: string | Uint8Array): void; readonly bufferedAmount: number; onMessage(h: (data: string | Uint8Array) => void): void; onClose(h: () => void): void; close(code?: number, reason?: string): void }`
  - `interface Transport { publish(sessionId: string): Promise<{ baseUrl: string }>; onConnection(sessionId: string, h: (conn: ViewerConnection) => void): void; unpublish(sessionId: string): Promise<void>; close(): Promise<void> }`. The session builds the link as `${baseUrl}#t=${token}`.
  - `createEngine(opts: {transport: Transport; log?: EventLog; secret?: Uint8Array; now?: () => number; defaultTimeoutS?: number; onLink?: (info: {sessionId:string; url:string; reason:string; expiresAt:number}) => void}): Engine`
  - `interface Engine { takeover(cdp: CdpClient, opts: {reason: string; timeoutS?: number; site?: string; onLink?: LinkHandler}): Promise<TakeoverResult>; close(): Promise<void> }`, where `LinkHandler = (info: {sessionId:string; url:string; reason:string; expiresAt:number}) => void`. A per-call `onLink` is used instead of the engine-level one. `close()` cancels in-flight takeovers (`cancelled`, detail `engine_closed`) and closes the transport.
  - `takeover()` **never rejects**: every failure becomes a `TakeoverResult`.
- Session behaviour (spec §6, §9, §10):
  1. Create the ID, token and expiry (`now + timeoutS*1000`, default 600 s), log `created`, `publish`, log `published`, transition through `notifying` (no notifiers in Plan 1) to `waiting`, call `onLink`.
  2. On connection: the first message must be `hello` within **10 s**, else close. A valid token is redeemed once: the first redeemer gets `ready {reason, site, expiresAt, resumeKey}` (resumeKey = `newSessionId()`) and becomes the viewer (`active`). A later `hello` with the same token while a viewer holds the session, or after it was redeemed without the matching `resumeKey`, gets `error token_used` and is closed (the holder is unaffected). A bad token gets `token_invalid`; an expired one gets `expired`.
  3. While `active`: start the screencast, `push(encodeFrame(f))` through `createLatestSender`, run `drain` every **50 ms**. Route mouse/wheel/key/text to `applyInput` and count them (`inputCount`; content never logged). `ping` gets `pong`. Invalid messages get `error bad_message` (connection stays open).
  4. Viewer disconnect → stop the screencast, `waiting`. A reconnect `hello {token, resumeKey}` within **60 s** of the disconnect resumes; after 60 s the resumeKey is invalid.
  5. `done` → `resolved`; `cant_solve` → `cancelled` with detail = reason or `cant_solve`; timer reaching the expiry → `timed_out`; `cdp.onClose` → `failed` with detail `page_closed`; `applyInput` or `startScreencast` throwing → `failed` with detail `cdp_error: <message>`.
  6. On any terminal state: send `state {status}` to the viewer, close it, stop the screencast, clear timers, `unpublish`, log `finished {status, durationS, inputCount}`, and resolve.

- [ ] **Step 1: Write failing tests** (Vitest fake timers, `FakeCdp`, `FakeTransport` whose `connect()` returns a fake viewer exposing `sent[]` and `push(msg)`):
  - happy path: hello with the token from `onLink`'s URL fragment → `ready` received → `Page.startScreencast` called → emitted frame reaches the viewer as binary starting with `0x01` → mouse down/up reach `FakeCdp` → `done` → result `{status:'resolved'}`, `unpublish` called, `Page.stopScreencast` called.
  - **Review Focus 2:** second viewer with the same token while the first is active gets `{t:'error', code:'token_used'}` and is closed; the first still receives frames and its `done` resolves.
  - **Review Focus 3:** `FakeCdp.close('detached')` during `active` → result `failed`, detail `page_closed`, within the same tick (no timer advance needed).
  - **Review Focus 5:** no viewer joins; advance 600 000 ms → result `timed_out`; `unpublish` called; `vi.getTimerCount()` is 0 afterwards.
  - resume: viewer disconnects, reconnects after 30 s with `{token, resumeKey}` → `ready` again, screencast restarted; a reconnect after 61 s → `token_used`.
  - hello timeout: connection that sends nothing for 10 s is closed; the session is still `waiting`.
  - `cant_solve {reason:'image unclear'}` → `cancelled`, detail `image unclear`.
  - log privacy: after `{t:'text', text:'hunter2'}` and key events, `JSON.stringify(log.events)` doesn't contain `hunter2`, and the `finished` event has `inputCount: 3`.
  - `engine.close()` during `waiting` → result `cancelled`, detail `engine_closed`; `transport.close` called.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** `runTakeover(deps, cdp, opts)` in `takeover.ts` (one function per state handler, using `nextStatus` for every transition) and `createEngine` in `engine.ts`.
- [ ] **Step 4: Run them.** Expected: PASS, runtime checker exit 0.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): takeover session lifecycle and engine"`

### Task 7: engine: tunneled CDP + stdio host + JSONL log

**Files:**
- Create: `engine/{package.json, LICENSE (Apache-2.0), tsconfig.json}`, `engine/src/tunnel.ts`, `engine/src/stdio-host.ts`, `engine/src/jsonl-log.ts`, `engine/test/{tunnel,stdio-host,jsonl-log}.test.ts`

**Interfaces:**
- Consumes: `createRpcPeer`, `Methods` (Task 3); `CdpClient`, `createEngine`, `EventLog` (Tasks 5–6).
- Produces:
  - `createTunneledCdp(peer: RpcPeer, pageId: string): CdpClient`. `send` → `peer.request('cdp.send', {pageId, method, params})`. The first `on(event)` for a new event name calls `cdp.subscribe {pageId, events:[name]}` (once per name). `cdp.event` and `cdp.closed` notifications for this `pageId` dispatch to handlers.
  - `runStdioHost(opts: {input: NodeJS.ReadableStream; output: NodeJS.WritableStream; transport: Transport; logPath?: string; version: string}): Promise<void>`. Reads JSON lines, handles `engine.hello` (rejects with code `protocol_mismatch` if `protocolVersion !== 1`), `takeover` (creates a tunneled CDP for `pageId`, runs `engine.takeover`, sends `takeover.link` via `onLink`), and `shutdown` (closes the engine and resolves). Resolves when input ends (the SDK exited): it closes the engine then.
  - `class JsonlFileEventLog implements EventLog { constructor(path: string) }`: appends one JSON line per event (`appendFileSync`). Default path `UNSTUCK_LOG` env, else `~/.unstuck/events.jsonl`; directory created if missing.

- [ ] **Step 1: Write failing tests.**
  - tunnel: with a peer pair whose SDK side handles `cdp.send` by echoing `{echo: method}`, `cdp.send('Runtime.evaluate')` resolves `{echo:'Runtime.evaluate'}`; two `on('Page.screencastFrame')` calls produce exactly one `cdp.subscribe`; a `cdp.event` for another pageId isn't delivered; `cdp.closed` fires `onClose` handlers with the reason.
  - stdio host (PassThrough streams + `FakeTransport` from `@unstuck/core/testing`): `engine.hello {protocolVersion:1}` → `{protocolVersion:1, engineVersion}`; `{protocolVersion:2}` → error `protocol_mismatch`; a `takeover` request produces a `takeover.link` notification whose `url` contains `#t=`; ending the input stream resolves `runStdioHost`; nothing but valid JSON lines is ever written to output.
  - jsonl log: two appends produce two parseable lines in a temp file.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Use `readline` on input; write `JSON.stringify(msg) + '\n'`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(engine): CDP tunnel, stdio host, JSONL event log"`

### Task 8: engine: embedded transport (HTTP + WebSocket on 127.0.0.1)

**Files:**
- Create: `engine/src/embedded.ts`, `engine/scripts/embed-viewer.mjs` (writes `engine/src/assets.gen.ts`), `engine/test/embedded.test.ts`

**Interfaces:**
- Consumes: `Transport`, `ViewerConnection` (Task 6). Viewer build output `viewer/dist/` (Task 9). Until Task 9 lands, tests use a fixture asset map.
- Produces:
  - `assets.gen.ts`: `export const ASSETS: Record<string, {type: string; body: string /* base64 */}>`, keyed by URL path (`/index.html`, `/assets/…`)
  - `createEmbeddedTransport(opts?: {host?: string; port?: number; assets?: typeof ASSETS; warn?: (msg: string) => void}): Promise<Transport & {port: number; host: string}>`. Defaults: host `127.0.0.1`, port `0` (any free port; also `UNSTUCK_PORT` / `UNSTUCK_HOST` env). A host other than `127.0.0.1`/`localhost`/`::1` calls `warn` with text containing `reachable from your network`.
  - Routes: `GET /s/:id` → `index.html` if published, otherwise **404 with a small self-contained HTML page** reading "This link has expired or is invalid" (same CSP); `GET /assets/*` → static; `GET /ws/:id` upgrade → WebSocket handed to `onConnection` (404/close if unpublished); anything else 404. `publish` returns `baseUrl = http://${host}:${port}/s/${id}`.
  - Headers on HTML: `Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. WebSocket `maxPayload` 64 KiB (viewer→engine messages are small).
  - `ViewerConnection.send` uses binary for `Uint8Array`, text for strings; `bufferedAmount` from `ws`.

- [ ] **Step 1: Write failing tests.**
  - server listens on 127.0.0.1 by default (`transport.host === '127.0.0.1'`); `host:'0.0.0.0'` calls `warn`.
  - published session: `GET /s/<id>` → 200 with the CSP and Referrer-Policy headers above; unpublished `GET /s/nope` → 404; after `unpublish`, the same URL → 404.
  - WebSocket to `/ws/<id>` triggers `onConnection`; a text message from the client reaches `onMessage`; `conn.send(new Uint8Array([1,2]))` arrives as a binary message; WebSocket to an unpublished id is refused.
  - `close()` frees the port (a new server can bind the same port).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** with `node:http` + `ws`. `embed-viewer.mjs` reads `viewer/dist/**` and writes base64 entries with the right MIME type (`.html`, `.js`, `.css`, `.svg`, `.png`, `.webmanifest`).
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(engine): embedded HTTP/WebSocket transport"`

### Task 9: viewer: standalone takeover page

**Files:**
- Create: `viewer/{package.json, LICENSE (AGPL-3.0), tsconfig.json, vite.config.ts, index.html}`, `viewer/src/{main.tsx, App.tsx, mapping.ts, keys.ts, connection.ts, styles.css}`, `viewer/test/{mapping,keys,connection}.test.ts`

**Interfaces:**
- Consumes: `encodeFrame/decodeFrame`, `ViewerToEngine`, `EngineToViewer` (Task 3).
- Produces (pure functions, unit-tested):
  - `fitContain(box: {width:number; height:number}, page: {width:number; height:number}): {left:number; top:number; width:number; height:number}`: where the page image sits inside the canvas box, letterboxed.
  - `toPagePoint(client: {x:number; y:number}, canvasRect: {left:number; top:number; width:number; height:number}, page: {width:number; height:number}): {x:number; y:number} | null`. Returns `null` in the letterbox area; result rounded to 0.1 px.
  - `keyEventToMessage(e: Pick<KeyboardEvent,'type'|'key'|'code'|'altKey'|'ctrlKey'|'metaKey'|'shiftKey'|'isComposing'>): ViewerToEngine | null`. Modifiers bitmask Alt=1, Ctrl=2, Meta=4, Shift=8 (CDP). `text` is set only for single printable characters with no Ctrl/Meta, and Enter gives text `'\r'`. Returns `null` while `isComposing` (IME: the composed result is sent as `{t:'text'}` on `compositionend`).
  - `parseFragment(hash: string): {token: string} | null` (reads `t=` from `#t=…`)
  - `connect(wsUrl: string, token: string, handlers: {...}): ViewerSocket` with `send(msg: ViewerToEngine)`, automatic `resumeKey` reconnect (up to 60 s, backoff 0.5/1/2/4 s), `ping` every 20 s, and a frame callback receiving decoded frames.
- UI (use the `ui-ux-pro-max` skill for the visual design; spec §9 for constraints): full-viewport canvas with the page letterboxed; top bar with reason, site domain, countdown to expiry; bottom bar with **Done** (primary) and **Can't solve** (secondary, asks for an optional reason). States: connecting, live, reconnecting, "Link already in use", "Link expired", "Finished: you can close this tab". Pointer events: `pointerdown/up/move` (move throttled to one per animation frame) → mouse; wheel → wheel; physical keyboard → `keyEventToMessage`; paste event → `{t:'text'}`; on touch devices, a "Keyboard" button focuses a hidden input whose `input` events send `{t:'text'}`. Touch targets ≥ 44×44 px, visible focus rings, `prefers-reduced-motion` respected. No third-party scripts or fonts (CSP).

- [ ] **Step 1: Write failing tests** (Vitest, jsdom):
  - **Review Focus 1:** `fitContain({width:390,height:844},{width:1280,height:720})` → `{left:0, top:323.3 (±0.1), width:390, height:219.4 (±0.1)}`; `toPagePoint({x:195, y:433}, rect(0,0,390,844), page 1280×720)` → `{x:640, y:360}` (±0.5); a point at `y:100` (letterbox) → `null`; with a canvas rect offset `left:20, top:50` the same logical point maps identically; a 2× devicePixelRatio canvas (backing store 780×1688, CSS rect 390×844) gives the same result (the mapping uses CSS rect only).
  - keys: `{type:'keydown', key:'a', code:'KeyA'}` → `{t:'key', action:'down', key:'a', code:'KeyA', text:'a', modifiers:0}`; Ctrl+C → no `text`, modifiers `2`; Enter → `text:'\r'`; `isComposing:true` → `null`.
  - `parseFragment('#t=abc.def')` → `{token:'abc.def'}`; `''` → `null`.
  - connection (mock WebSocket): sends `hello {token}` on open; after `ready`, a socket close triggers reconnect with `{token, resumeKey}`; an `error token_used` stops reconnecting.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the pure modules, then the Preact UI. WS URL = `location.origin.replace(/^http/,'ws') + '/ws/' + sessionIdFromPath`.
- [ ] **Step 4: Run them, then build.** `pnpm --filter @unstuck/viewer test` → PASS; `pnpm --filter @unstuck/viewer build` → `viewer/dist/index.html` exists, total gzipped JS < 40 KB; `node scripts/check-runtime-agnostic.mjs` exit 0.
- [ ] **Step 5: Commit.** `git commit -m "feat(viewer): standalone takeover page"`

### Task 10: engine: CLI + standalone binary

**Files:**
- Create: `engine/src/cli.ts`, `engine/scripts/build-binary.mjs`, `engine/test/cli.test.ts`

**Interfaces:**
- Consumes: `runStdioHost` (Task 7), `createEmbeddedTransport`, `ASSETS` (Task 8), viewer build (Task 9).
- Produces:
  - CLI `unstuck-engine`: `--version` prints the version; `--stdio` runs the stdio host with an embedded transport (`--host`, `--port` flags override env); `--help`. Unknown flags exit 2 with usage on stderr.
  - `pnpm --filter @unstuck/engine build` = `vite build` viewer → `embed-viewer.mjs` → `tsc` → `bun build src/cli.ts --compile --outfile dist/unstuck-engine` (current platform only in Plan 1; the cross-target matrix is in Plan 6). If `bun` is missing, the script prints `install bun: npm i -g bun` and exits 1.

- [ ] **Step 1: Write failing tests** (spawn `node --import tsx engine/src/cli.ts` in dev, and `engine/dist/unstuck-engine` when it exists):
  - `--version` prints `/^\d+\.\d+\.\d+/` and exits 0.
  - `--stdio`: writing an `engine.hello` line yields one JSON response line on stdout; stderr may contain logs but stdout contains nothing else; closing stdin makes the process exit 0 within 2 s.
  - `--bogus` exits 2.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the CLI with `node:util` `parseArgs` and the build script.
- [ ] **Step 4: Build and run.** `pnpm --filter @unstuck/engine build && pnpm --filter @unstuck/engine test`. Expected: PASS for both the dev and binary variants; `ls -lh engine/dist/unstuck-engine` shows a single file.
- [ ] **Step 5: Commit.** `git commit -m "feat(engine): CLI and standalone binary build"`

### Task 11: TypeScript SDK (`unstuck`)

**Files:**
- Create: `sdk-ts/{package.json (name "unstuck"), LICENSE (Apache-2.0), tsconfig.json, README.md}`, `sdk-ts/src/{index.ts, unstuck.ts, engine-process.ts, attach.ts, errors.ts}`, `sdk-ts/test/{attach,engine-process,unstuck}.test.ts`

**Interfaces:**
- Consumes: protocol RPC and methods (Task 3); engine binary or dev entry (Task 10).
- Produces:
  - `class UnstuckEngineError extends Error { enginePath?: string }`
  - `resolveEnginePath(opts: {enginePath?: string}): string`, in order: `opts.enginePath` → `UNSTUCK_ENGINE_PATH` → `@unstuck/engine-${process.platform}-${process.arch}` (resolved with `require.resolve`; packages arrive in Plan 6) → throw `UnstuckEngineError` whose message contains every path tried and the text `Set UNSTUCK_ENGINE_PATH`.
  - `spawnEngine(path: string, opts: {host?: string; port?: number}): Promise<{peer: RpcPeer; exited: Promise<number|null>; kill(): void}>`. Performs `engine.hello` (protocolVersion 1). Spawn error (ENOENT/EACCES) or exit before hello → `UnstuckEngineError` with the path. Engine stderr goes to `process.stderr` prefixed `[unstuck] `. The child is `unref`'d once idle so it never keeps the agent process alive.
  - `attachPage(page: unknown): Promise<AttachedPage>`, where `AttachedPage = {pageId: string; send(method, params): Promise<unknown>; subscribe(event, cb): void; onClose(cb: (reason: string) => void): void; detach(): Promise<void>}`. Playwright is detected by `page.context().newCDPSession`; Puppeteer by `page.createCDPSession`. Otherwise throws `TypeError('Unsupported page object: pass a Playwright or Puppeteer Page')`. `onClose` fires on the page `close` event and on CDP session detach.
  - `class Unstuck { constructor(opts?: {enginePath?: string; host?: string; port?: number; timeoutS?: number; onLink?: (link: {url:string; reason:string; sessionId:string; expiresAt:number}) => void}); takeover(page: unknown, opts: {reason: string; timeoutS?: number}): Promise<TakeoverResult>; close(): Promise<void> }`. Lazily spawns one engine; handles `cdp.send` / `cdp.subscribe` for attached pages; forwards `cdp.event` / `cdp.closed`. The default `onLink` prints `Unstuck: a human is needed (<reason>) → <url>` to stderr. If the engine exits mid-takeover, the pending `takeover()` rejects with `UnstuckEngineError('engine exited with code N')` and the next call respawns. `close()` sends `shutdown`, waits up to 2 s, then kills.
  - `index.ts` exports `Unstuck`, `UnstuckEngineError`, and types `TakeoverResult`, `TakeoverStatus`.

- [ ] **Step 1: Write failing tests** (Playwright from the pre-installed package, headless Chromium; engine via `UNSTUCK_ENGINE_PATH=engine/dist/unstuck-engine`):
  - attach: a Playwright page attaches and `send('Runtime.evaluate', {expression:'1+1', returnByValue:true})` returns `{result:{value:2}}`; `{}` throws the `TypeError` above.
  - **Review Focus 4:** `new Unstuck({enginePath:'/nonexistent/unstuck-engine'}).takeover(page, {reason:'x'})` rejects with `UnstuckEngineError`, message containing `/nonexistent/unstuck-engine` and `UNSTUCK_ENGINE_PATH`, in < 2 s; a fake engine script that exits immediately → `UnstuckEngineError`; a fake engine that answers hello then exits during takeover → rejection with `engine exited`, and a second `takeover` on a good engine path succeeds (respawn).
  - **Review Focus 3:** start a takeover, then `page.close()` → result `failed`, detail `page_closed`, in < 1 s.
  - **Review Focus 5:** a child Node script running `takeover(page, {reason:'x', timeoutS:1})` then `await unstuck.close(); await browser.close()` prints `timed_out` and exits by itself within 5 s (the test fails if the child has to be killed).
  - `onLink` is called once with a URL matching `^http://127\.0\.0\.1:\d+/s/[A-Za-z0-9_-]{22}#t=`.
- [ ] **Step 2: Run them.** `pnpm --filter unstuck test`. Expected: FAIL.
- [ ] **Step 3: Implement** with `node:child_process` `spawn` (stdio `['pipe','pipe','pipe']`) and `readline`.
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(sdk-ts): Unstuck SDK with engine process and page attach"`

### Task 12: End-to-end local takeover + quickstart

**Files:**
- Create: `e2e/{package.json, fixtures/fake-captcha.html, local-takeover.test.ts}`, `examples/playwright-ts/index.ts`
- Modify: root `README.md` (5-minute quickstart), `sdk-ts/README.md`

**Interfaces:**
- Consumes: `Unstuck` (Task 11), built engine and viewer (Tasks 9–10).

Fixture `fake-captcha.html`: a centered button "I'm not a robot" (`#robot`) that increments `window.clicks` and shows ✓; a text input `#answer`; served from a local `http.createServer` started in the test (so `site` is `127.0.0.1`). No third-party scripts.

- [ ] **Step 1: Write failing tests.** Agent: Chromium page 1280×720 on the fixture. Human: a second browser context with the **iPhone 13** device descriptor (390×844).
  - happy path: `takeover(page, {reason:'Solve the test CAPTCHA'})`; the human opens the `onLink` URL; waits for the first frame (canvas has non-zero pixels, via `page.waitForFunction`); computes `#robot`'s center from the agent page's `boundingBox()`, maps it to canvas coordinates with the same letterbox math as `fitContain`, and taps there; focuses `#answer` the same way, taps the viewer's Keyboard button and types `héllo 日本` (via `keyboard.insertText`); taps **Done**. Assert result `resolved`, `await page.evaluate('window.clicks') === 1`, `#answer` value `héllo 日本`, and that the viewer shows the "Finished" state.
  - **Review Focus 2:** a third browser context opening the same URL while the human is live sees "Link already in use", and the human's Done still resolves.
  - can't solve: the human taps Can't solve with reason `blurry` → result `cancelled`, detail `blurry`.
  - expired link: `timeoutS: 2`, nobody joins → `timed_out`; opening the URL afterwards returns 404 and the page text contains "expired or is invalid".
- [ ] **Step 2: Run them.** `pnpm --filter e2e test`. Expected: FAIL until the build is wired; then iterate.
- [ ] **Step 3: Write the quickstart** in `README.md` and `examples/playwright-ts/index.ts`: install, `UNSTUCK_ENGINE_PATH` (until Plan 6 ships platform packages), 10-line example, what the human sees. Only commands that were run in Step 4.
- [ ] **Step 4: Full verification.** `pnpm -r build && pnpm -r test && node scripts/check-runtime-agnostic.mjs && pnpm --filter e2e test`. Expected: all PASS. Then run `examples/playwright-ts/index.ts` by hand, open the link, and confirm the takeover works.
- [ ] **Step 5: Commit.** `git commit -m "test(e2e): local takeover end to end; quickstart"`

---

## Roadmap: later plans

Each later plan is written when the previous one is merged, using that plan's real interfaces.

| Plan | Scope (spec sections) | Ends with |
|---|---|---|
| 2 | Python SDK (`pip install unstuck`, platform wheels bundling the engine), MCP server mode (`request_human_takeover`), rule packs + `watch()` with agent pause, fixture widgets + official test sitekeys, browser capability check + `unstuck doctor`, following popups/new tabs during a takeover (§4.4, §5, §6 watch, §7, §10) | Python and MCP takeovers; auto-detection on the fixture site |
| 3 | relay-core, relay-node (Docker), relay-cloudflare (Durable Objects), AES-GCM end-to-end encryption, 6-digit code, agent keys, rate limits, core tests under `workerd` (§4, §9) | Takeover through both relays with ciphertext-only relays |
| 4 | Notifier interface + the 11 channels, escalation, Web Push enrollment, redacted thumbnails (§8, §7.2 redaction) | Golden-payload tests for every channel; real-service smoke script |
| 5 | `<unstuck-viewer>` web component, `@unstuck/astro`, in-process SDK mode (Workers/Bun/Deno), Cloudflare Browser Rendering example (uses Task 2 findings), Tier 2 compatibility suite incl. Obscura (uses Task 1 findings), `CloudDetector` stub (§4.3, §4.4, §7.2) | Takeover from a Cloudflare Worker agent; Astro dashboard example |
| 6 | Cross-platform binary matrix (5 targets), `@unstuck/engine-*` packages, PyPI wheels, Changesets, GHCR image, Deploy-to-Workers button, docs site, examples, licensing review (§12, §14) | Published packages and launch |
