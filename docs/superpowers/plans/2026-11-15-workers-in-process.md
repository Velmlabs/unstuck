# Workers Phase 1: in-process mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `new Unstuck({ apiKey }).takeover(page, { reason })` works inside a Cloudflare Worker (Durable Object), Deno and Bun with the same API and results as on Node, released as 0.2.0.

**Architecture:** The web-standard parts of `engine/` (relay/viewer selection, Cloud alerts, `hostnames()`) move to `core/src/cloud/`. `sdk-ts` gains an in-process implementation (`createEngine()` + `createRelayTransport()` from core, the page's CDP session adapted straight to core's `CdpClient`) exposed through a new `edge.ts` entry selected by export conditions; Node keeps binary mode by default and gets `mode: 'in-process'` as an opt-in. New options are shared: on Node binary mode they become the environment variables the engine already reads.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest (v8 coverage; `@cloudflare/vitest-plugin` for workerd), Wrangler 4, Playwright, esbuild, tsup.

**Spec:** `docs/superpowers/specs/2026-11-15-workers-in-process-design.md`

## Global Constraints

- Coverage above 90% (lines, statements, functions, branches) in every package; `pnpm test` enforces it.
- `protocol/`, `core/` and `viewer/` import no Node built-ins: `node scripts/check-runtime-agnostic.mjs protocol/src core/src viewer/src`. Nothing in `core/src/cloud/` may touch `process`.
- The edge entry's whole import graph has no `node:*` module and never reaches `engine-process.ts` or `@velmlabs/unstuck-engine`.
- Same `Unstuck` class name, `takeover()` options and `TakeoverResult` (`resolved` / `cancelled` / `timed_out` / `failed`, `durationS`, `detail`) in both entries.
- Errors: `apiKey` + `relay` → `UnstuckConfigError`; `cloudRelay`/`cloudApi` without `apiKey` → `UnstuckConfigError`; no relay in a Worker → `UnstuckConfigError` with "in a Worker, Unstuck needs a relay: set apiKey or relay + agentKey".
- Precedence is option → environment variable → default. In a Worker there is no environment (options only).
- Keep-alive: `Runtime.evaluate` every 60 000 ms for the whole takeover.
- Default `onLink` in in-process mode: `console.log` the link; never print a 6-digit code (requireCode still needs its own `onLink`).
- Never log an API key, agent key or link secret.
- Commits: author and committer `Velm Labs <velmlabs@users.noreply.github.com>`, no AI attribution lines. Work on branch `workers-phase1`.
- Release version 0.2.0.

## Review Focus

1. **`apiKey` option while `UNSTUCK_RELAY_URL` is set in the environment (Node):** the option wins; the Cloud key goes to the Cloud relay only, never to the env relay. Test in Task 2.
2. **Page closes before the first takeover finishes creating the engine (edge):** result `failed` / `page_closed`, nothing thrown, no leaked keep-alive timer. Test in Task 3.
3. **Two concurrent takeovers on one `Unstuck` in a Worker:** one engine, one relay transport, each takeover gets its own result and its own keep-alive; `close()` cancels both (`engine_closed`). Test in Task 3.
4. **Relay rejects the API key (`relay_unauthorized`):** result `failed` with detail `relay_unauthorized` and a single `console.error` line that names the dashboard but not the key. Test in Task 3.
5. **Keep-alive ping rejects (browser gone):** the failure is swallowed, the takeover ends through the page's close path, no unhandled rejection. Test in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `core/src/cloud/transport.ts` (new) | `CLOUD_*` URLs, `TransportChoice`, `selectTransport`, `viewerUrlFor`, `cloudAlertsFor`, `buildRelayTransport` |
| `core/src/cloud/alerts.ts` (new) | `createCloudAlerter` (moved from engine) |
| `core/src/cloud/sites.ts` (new) | `hostnames()` (moved from engine) |
| `engine/src/transport-select.ts`, `cloud-alerts.ts`, `stdio-host.ts`, `mcp.ts` | Re-import from core; `buildTransport` becomes a thin wrapper |
| `sdk-ts/src/options.ts` (new) | `UnstuckOptions`, `TakeoverOptions`, `validateOptions`, `optionEnv` |
| `sdk-ts/src/errors.ts` | + `UnstuckConfigError` |
| `sdk-ts/src/cdp-adapter.ts` (new) | `toCdpClient(AttachedPage)`, `startKeepAlive` |
| `sdk-ts/src/in-process.ts` (new) | `InProcessUnstuck` |
| `sdk-ts/src/edge.ts` (new) | Edge entry: `Unstuck` = in-process |
| `sdk-ts/src/unstuck.ts`, `engine-process.ts`, `index.ts` | Node entry: shared options, `mode`, env passing |
| `sdk-ts/package.json`, `tsup.config.ts` | Export conditions, core dependency, `edge` build |
| `scripts/check-edge-graph.mjs` (new) | Import-graph check from an entry file |
| `sdk-ts/test-workers/` (new) | workerd test with `@cloudflare/vitest-plugin` |
| `e2e/workers/` (new) | DO test Worker + `workers.test.ts` |
| `scripts/release.mjs` | Edge smoke step; versions → 0.2.0 |

---

### Task 1: Move cloud selection, alerts and `hostnames()` into core

**Files:**
- Create: `core/src/cloud/transport.ts`, `core/src/cloud/alerts.ts`, `core/src/cloud/sites.ts`, `core/test/cloud/transport.test.ts`, `core/test/cloud/alerts.test.ts`, `core/test/cloud/sites.test.ts`
- Modify: `core/src/index.ts`, `engine/src/transport-select.ts`, `engine/src/cloud-alerts.ts`, `engine/src/stdio-host.ts:103-111`, `engine/src/mcp.ts:6`, `package.json` (`check:runtime`)
- Test: move the bodies of `engine/test/transport-select.test.ts` and `engine/test/cloud-alerts.test.ts` into the core tests; keep a small engine test that `buildTransport` still prints the `UNSTUCK_API_KEY` rejection line.

**Interfaces:**
- Produces (exported from `@velmlabs/unstuck-core`):
  - `CLOUD_RELAY_URL`, `CLOUD_VIEWER_URL`, `CLOUD_API_URL`, `type TransportChoice`, `selectTransport(flags, env)`, `viewerUrlFor(choice, env, version)`, `cloudAlertsFor(choice, env)`: signatures unchanged from `engine/src/transport-select.ts`.
  - `buildRelayTransport(choice: Extract<TransportChoice, {kind:'relay'}>, o: { env: Record<string, string | undefined>; version: string; warn: (line: string) => void }): Transport` — the body of today's `buildTransport` after the embedded check (viewer URL, `relay_unauthorized` warning for source `UNSTUCK_API_KEY`).
  - `createCloudAlerter(o: CloudAlerterOptions)`, `type CloudAlerterOptions`, `MAX_REASON`, `MAX_SITE`: unchanged, except the default `log` is `(l) => console.error(l)`.
  - `hostnames(raw: unknown): string[]`: unchanged.
- Engine keeps `buildTransport(flags, env, stderr)` as `selectTransport` → `null` for embedded, else `{ transport: buildRelayTransport(choice, { env, version: VERSION, warn: (l) => stderr.write(l + '\n') }), description }`. `engine/src/transport-select.ts` and `cloud-alerts.ts` re-export the moved names so `cli.ts` imports are unchanged.

- [ ] **Step 1: Write the failing tests** — copy the engine tests to `core/test/cloud/*.test.ts` importing from `../../src/cloud/...`; add `buildRelayTransport` tests:

```ts
it('warns once per rejected publish for Cloud keys, without the key', async () => {
  const warn = vi.fn();
  const t = buildRelayTransport({ kind: 'relay', url: 'ws://127.0.0.1:1', agentKey: 'sk_secret', source: 'UNSTUCK_API_KEY' }, { env: {}, version: '0.2.0', warn });
  // publish against a fake relay that answers 401 → RelayError('relay_unauthorized')
  await expect(t.publish('s1', publishOpts)).rejects.toMatchObject({ detail: 'relay_unauthorized' });
  expect(warn).toHaveBeenCalledWith('[unstuck] unstuck.sh rejected the API key: check the key in your dashboard');
  expect(warn.mock.calls.flat().join()).not.toContain('sk_secret');
});
it('does not warn for a self-hosted relay key', ...);
it('uses the hosted viewer pinned to the version for the Cloud relay', ...); // viewerUrl https://view.unstuck.sh/v/0.2.0
it('createCloudAlerter logs with console.error by default', ...);
```

(The message drops the env-variable name because in a Worker the key comes from an option.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @velmlabs/unstuck-core exec vitest run test/cloud`
Expected: FAIL, cannot resolve `../../src/cloud/transport`.

- [ ] **Step 3: Move the code** into the three core files, export them from `core/src/index.ts`, switch engine files to import/re-export from core, delete the moved engine tests, add `@velmlabs/unstuck-protocol` use in core alerts (already a core dependency). Update the engine's warning-line test to the new message.

- [ ] **Step 4: Verify**

Run: `pnpm --filter @velmlabs/unstuck-core test && pnpm --filter @velmlabs/unstuck-engine test && pnpm check:runtime`
Expected: all pass, coverage ≥ 90% in both, no runtime violations.

- [ ] **Step 5: Commit** — `git commit -m "refactor(core): move Cloud relay selection, alerts and hostnames from engine to core"`

---

### Task 2: Shared options, `UnstuckConfigError`, Node binary passes options as env

**Files:**
- Create: `sdk-ts/src/options.ts`, `sdk-ts/test/options.test.ts`
- Modify: `sdk-ts/src/errors.ts`, `sdk-ts/src/unstuck.ts` (move `UnstuckOptions` and the takeover options type out, import them), `sdk-ts/src/engine-process.ts:57-66`, `sdk-ts/src/index.ts`, `sdk-ts/test/engine-process.test.ts`, `sdk-ts/test/unstuck.test.ts`

**Interfaces:**
- Produces:
  - `class UnstuckConfigError extends Error` (`name = 'UnstuckConfigError'`), exported from both entries.
  - `interface UnstuckOptions` = today's fields + `apiKey?: string; cloudRelay?: string; cloudApi?: string; viewerUrl?: string; mode?: 'binary' | 'in-process'; fetch?: typeof fetch` (JSDoc marks `enginePath`/`host`/`port` Node-only, `fetch` for tests).
  - `interface TakeoverOptions { reason: string; timeoutS?: number; requireCode?: boolean; allowedSites?: string[]; alerts?: boolean }` (today's inline type with its JSDoc).
  - `validateOptions(o: UnstuckOptions): void` — throws `UnstuckConfigError` for `apiKey && relay` ("use either apiKey (Unstuck Cloud) or relay + agentKey (your own relay), not both") and for `(cloudRelay || cloudApi) && !apiKey` ("cloudRelay and cloudApi only apply with apiKey").
  - `optionEnv(o: UnstuckOptions): Record<string, string | undefined>` — `apiKey` → `UNSTUCK_API_KEY` **and** `UNSTUCK_RELAY_URL: undefined, UNSTUCK_AGENT_KEY: undefined`; `cloudRelay` → `UNSTUCK_CLOUD_URL`; `cloudApi` → `UNSTUCK_CLOUD_API`; `viewerUrl` → `UNSTUCK_VIEWER_URL`; `relay` → `UNSTUCK_RELAY_URL`; `agentKey` → `UNSTUCK_AGENT_KEY`. Unset options add no key.
  - `spawnEngine(path, opts: { host?, port?, env: Record<string, string | undefined> })` — the caller passes `{ ...process.env, ...optionEnv(o) }`; keys whose value is `undefined` are removed before `spawn`.
- `Unstuck` constructor calls `validateOptions` (throws synchronously).

- [ ] **Step 1: Write the failing tests**

```ts
it('rejects apiKey with relay', () => expect(() => new Unstuck({ apiKey: 'k', relay: 'wss://r' })).toThrow(UnstuckConfigError));
it('rejects cloudApi without apiKey', () => expect(() => validateOptions({ cloudApi: 'https://staging' })).toThrow(/only apply with apiKey/));
it('maps options to engine env', () =>
  expect(optionEnv({ apiKey: 'k', cloudRelay: 'wss://s', cloudApi: 'https://a', viewerUrl: 'https://v' })).toEqual({
    UNSTUCK_API_KEY: 'k', UNSTUCK_RELAY_URL: undefined, UNSTUCK_AGENT_KEY: undefined,
    UNSTUCK_CLOUD_URL: 'wss://s', UNSTUCK_CLOUD_API: 'https://a', UNSTUCK_VIEWER_URL: 'https://v' }));
it('apiKey option beats UNSTUCK_RELAY_URL in the environment', async () => {
  // engine-process test with a fake engine script that echoes its env: UNSTUCK_RELAY_URL absent, UNSTUCK_API_KEY=k
});
it('passes relay/agentKey as before', ...);
```

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @velmlabs/unstuck exec vitest run test/options.test.ts test/engine-process.test.ts` → FAIL (`options` module missing).

- [ ] **Step 3: Implement** `options.ts`, the error class, the `spawnEngine` env parameter, and wire `Unstuck` (constructor validation, `ensureEngine` passes `env`).

- [ ] **Step 4: Verify** — `pnpm --filter @velmlabs/unstuck test` → PASS, coverage ≥ 90%.

- [ ] **Step 5: Commit** — `git commit -m "feat(sdk-ts): apiKey, cloudRelay, cloudApi and viewerUrl options; UnstuckConfigError"`

---

### Task 3: In-process `Unstuck` (adapter, keep-alive, popups, alerts)

**Files:**
- Create: `sdk-ts/src/cdp-adapter.ts`, `sdk-ts/src/in-process.ts`, `sdk-ts/test/cdp-adapter.test.ts`, `sdk-ts/test/in-process.test.ts`
- Modify: `sdk-ts/src/unstuck.ts` (`mode: 'in-process'` delegates), `sdk-ts/package.json` (+ `"@velmlabs/unstuck-core": "workspace:*"` dependency)

**Interfaces:**
- Consumes: Task 1 core exports; Task 2 `UnstuckOptions`, `TakeoverOptions`, `validateOptions`, `optionEnv`, `UnstuckConfigError`; `attachPage`, `PageClosedError`, `AttachedPage` from `attach.ts`; `createEngine`, `Engine`, `CdpClient`, `PopupSource` from core.
- Produces:
  - `toCdpClient(page: AttachedPage): CdpClient` — `send` forwards; `on(event, h)` keeps one `page.subscribe` per event and a handler set, returning a remover; `onClose(h)` registers on the page once at creation, and a handler added after close is called with the recorded reason on a microtask.
  - `startKeepAlive(cdp: CdpClient, intervalMs = 60_000): () => void` — `cdp.send('Runtime.evaluate', { expression: '0' })` each interval; rejections swallowed; returns stop.
  - `class InProcessUnstuck { constructor(opts: UnstuckOptions, env: Record<string, string | undefined>); takeover(page: unknown, o: TakeoverOptions): Promise<TakeoverResult>; close(): Promise<void> }`.
    - Effective env = `{ ...env, ...optionEnv(opts) }` → `selectTransport({}, effective)`; `kind: 'embedded'` → `takeover()` rejects with `UnstuckConfigError` (spec message).
    - One engine, created lazily on first `takeover()`: `createEngine({ transport: buildRelayTransport(choice, { env: effective, version: VERSION, warn: console.error }) })`.
    - Alerter: `cloudAlertsFor(choice, effective)` → `createCloudAlerter({ ...cloud, fetch: opts.fetch })`, called when `o.alerts !== false`.
    - `engine.takeover(toCdpClient(attached), { reason, timeoutS: o.timeoutS ?? opts.timeoutS, site, requireCode, allowedSites: hostnames(o.allowedSites), popups, onLink })`; `onLink` calls `opts.onLink ?? ((l) => console.log(\`Unstuck: a human is needed (${l.reason}) → ${l.url}\`))` with the same `TakeoverLink` shape as binary mode.
    - Popups: `PopupSource` whose `onPopup(cb)` listens to `page.on('popup')`, attaches each popup with `attachPage` and calls `cb(toCdpClient(popup))`; listener removed and popups detached in `finally`.
    - requireCode-without-onLink `TypeError` as on Node, reading `UNSTUCK_REQUIRE_CODE` from `env`.
    - `PageClosedError` from `attachPage` → `{ status: 'failed', sessionId: '', url: '', durationS: 0, detail: 'page_closed' }`.
    - Keep-alive started after attach, stopped in `finally`.
    - `close()` → `engine.close()` (cancels running takeovers with `engine_closed`, closes the transport); a later `takeover()` makes a new engine.
  - Node `Unstuck`: when `opts.mode === 'in-process'`, every method delegates to `new InProcessUnstuck(opts, process.env)`.

- [ ] **Step 1: Write the failing adapter tests** (`cdp-adapter.test.ts`, with a fake `AttachedPage`): one `subscribe` per event for two handlers; the remover stops one handler only; `onClose` after close fires with the reason; `startKeepAlive` with fake timers sends `Runtime.evaluate` at 60 s and 120 s, not at 59 s; a rejecting `send` produces no unhandled rejection; stop clears the timer.

- [ ] **Step 2: Write the failing in-process tests** (`in-process.test.ts`) using core's `FakeCdp`, `FakeTransport`/`FakeViewer`, `FakePopups` from `@velmlabs/unstuck-core/testing` (inject the transport through a module mock of `buildRelayTransport` or a test-only `transport` seam on the constructor — pick one and keep it out of the public type):

```ts
it('throws UnstuckConfigError without a relay', async () =>
  await expect(new InProcessUnstuck({}, {}).takeover(page, { reason: 'x' })).rejects.toThrow('in a Worker, Unstuck needs a relay: set apiKey or relay + agentKey'));
it('resolves when the viewer presses Done', ...);           // status 'resolved', durationS ≥ 0
it('times out with timed_out', ...);
it('default onLink logs the link with console.log and never the code', ...);
it('sends alerts with an apiKey and skips them with alerts: false', ...); // fake fetch sees GET /api/v1/agent/devices only in the first case
it('no alerts for a self-hosted relay', ...);
it('follows a popup opened during the takeover', ...);
it('filters allowedSites through hostnames()', ...);          // ['com', 'accounts.google.com'] → ['accounts.google.com']
// Review Focus
it('page closed while the engine is starting → failed/page_closed, keep-alive stopped', ...);
it('two concurrent takeovers share one engine; close() ends both with engine_closed', ...);
it('relay_unauthorized → failed/relay_unauthorized and one console.error line without the key', ...);
it('a rejecting keep-alive ping is swallowed', ...);
it('Node: mode in-process uses process.env as fallback', ...); // UNSTUCK_API_KEY in env, no options → Cloud relay chosen
```

- [ ] **Step 3: Run to verify they fail** — `pnpm --filter @velmlabs/unstuck exec vitest run test/cdp-adapter.test.ts test/in-process.test.ts` → FAIL (modules missing).

- [ ] **Step 4: Implement** `cdp-adapter.ts`, `in-process.ts`, the `mode` delegation in `unstuck.ts`.

- [ ] **Step 5: Verify** — `pnpm --filter @velmlabs/unstuck test` → PASS, coverage ≥ 90%.

- [ ] **Step 6: Commit** — `git commit -m "feat(sdk-ts): in-process mode on core's engine, with keep-alive, popups and Cloud alerts"`

---

### Task 4: Edge entry, export conditions, import-graph check

**Files:**
- Create: `sdk-ts/src/edge.ts`, `scripts/check-edge-graph.mjs`, `scripts/check-edge-graph.test.mjs`
- Modify: `sdk-ts/package.json` (`exports`, `publishConfig.exports`), `sdk-ts/tsup.config.ts` (entry `edge`), `package.json` (`check:runtime` also runs `node scripts/check-edge-graph.mjs sdk-ts/src/edge.ts`), `.github/workflows/ci.yml` (if `check:runtime` isn't already a CI step, add it)

**Interfaces:**
- Consumes: `InProcessUnstuck` (Task 3), `UnstuckConfigError`, `PageClosedError`, types.
- Produces:
  - `sdk-ts/src/edge.ts`: `export class Unstuck` (constructor `validateOptions(opts)`, wraps `new InProcessUnstuck(opts, {})`), `UnstuckConfigError`, `UnstuckEngineError` (kept for type compatibility), `PageClosedError`, `type UnstuckOptions`, `TakeoverOptions`, `TakeoverLink`, `TakeoverResult`, `TakeoverStatus`.
  - Workspace `exports["."]`: `{ "workerd": "./src/edge.ts", "worker": "./src/edge.ts", "deno": "./src/edge.ts", "bun": "./src/edge.ts", "browser": "./src/edge.ts", "default": "./src/index.ts" }`; published: the same conditions pointing at `./dist/edge.js` with `types: ./dist/edge.d.ts`, then `import`/`default` → `./dist/index.js`.
  - `check-edge-graph.mjs <entry>`: follows relative imports and workspace packages (`@velmlabs/*` resolved through each package's `exports["."]`, honouring `workerd` when present) from the entry, exits 1 listing `file → specifier` for any Node built-in or any file under `engine/` or `sdk-ts/src/engine-process.ts`; exports `findEdgeViolations(entry): string[]` for tests.
- `edge.ts` must not import `unstuck.ts` (it imports `engine-process.ts`); move `TakeoverLink` into `options.ts` if needed.

- [ ] **Step 1: Write the failing test** (`scripts/check-edge-graph.test.mjs`, picked up by `scripts/vitest.config.ts`):

```js
it('passes for the edge entry', () => expect(findEdgeViolations('sdk-ts/src/edge.ts')).toEqual([]));
it('flags the Node entry', () => expect(findEdgeViolations('sdk-ts/src/index.ts').join('\n')).toMatch(/engine-process\.ts|node:child_process/));
it('flags a fixture that imports node:fs through a relative file', ...);
```

- [ ] **Step 2: Run to verify it fails** — `pnpm test:scripts` → FAIL (script missing).

- [ ] **Step 3: Implement** the entry, script, `package.json` conditions and tsup entry.

- [ ] **Step 4: Verify** — `pnpm test:scripts && pnpm check:runtime && pnpm --filter @velmlabs/unstuck build && pnpm --filter @velmlabs/unstuck build:dist && ls sdk-ts/dist/edge.js` → all pass, `dist/edge.js` exists.

- [ ] **Step 5: Commit** — `git commit -m "feat(sdk-ts): edge entry for Workers, Deno and Bun, with an import-graph check"`

---

### Task 5: Workers-runtime test in workerd

**Files:**
- Create: `sdk-ts/test-workers/edge.test.ts`, `sdk-ts/test-workers/wrangler.test.toml`, `sdk-ts/vitest.workers.config.ts`
- Modify: `sdk-ts/package.json` (`"test:workers": "vitest run --config vitest.workers.config.ts"`, devDependencies `@cloudflare/vitest-plugin`, `wrangler`, `@cloudflare/workers-types` at the versions `relay-cloudflare` uses), root `package.json` `test` (append `pnpm --filter @velmlabs/unstuck test:workers`)

**Interfaces:**
- Consumes: `@velmlabs/unstuck` resolved with the `workerd` condition (must land on `edge.ts`); `FakeCdp`, `FakeViewer` from `@velmlabs/unstuck-core/testing`; `relay-cloudflare`'s Durable Object as the relay inside the same miniflare (configured like `relay-cloudflare/vitest.config.ts`, `AGENT_KEYS: 'K'`) — or, if the DO can't be loaded from another package's test, a fake relay `WebSocketPair` handler in the test Worker.
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the test**

```ts
it('resolves a takeover inside workerd', async () => {
  const u = new Unstuck({ relay: RELAY_WS, agentKey: 'K', onLink: (l) => links.push(l) });
  const result = u.takeover(fakePuppeteerPage(new FakeCdp()), { reason: 'Solve the CAPTCHA' });
  const link = await nextLink();
  await viewerPressesDone(link);   // FakeViewer over the relay
  expect(await result).toMatchObject({ status: 'resolved' });
});
it('the workerd build picked the edge entry', () => expect(typeof process === 'undefined' || !('spawn' in Unstuck.prototype)).toBe(true)); // plus: import.meta.resolve / module id ends with edge.ts
it('no relay → UnstuckConfigError', ...);
```

- [ ] **Step 2: Run** — `pnpm --filter @velmlabs/unstuck test:workers` → PASS (if it fails on something other than the test itself, e.g. a Node API reached at runtime, fix the code in Tasks 1–4 and note it in the commit).

- [ ] **Step 3: Commit** — `git commit -m "test(sdk-ts): run the edge entry inside workerd"`

---

### Task 6: End-to-end under `wrangler dev` (DO agent, real Chromium, person in Playwright)

**Files:**
- Create: `e2e/workers/agent-worker.ts`, `e2e/workers/wrangler.toml`, `e2e/workers/cdp-page.ts`, `e2e/workers.test.ts`
- Modify: `e2e/package.json` (devDependency `wrangler`), CI e2e job if it lists test files explicitly

**Interfaces:**
- Consumes: `startRelay('cloudflare')`, `RELAY_KEY`, `freePort` from `e2e/relay-harness.ts`; `tapStart` pattern and `fixtures/fake-captcha.html` from `e2e/relay.test.ts`.
- Produces:
  - `agent-worker.ts`: a Worker with Durable Object `AgentDO`; `POST /run { cdpUrl, relay, agentKey, pageUrl }` starts `new Unstuck({ relay, agentKey, onLink }).takeover(createCdpPage(cdpUrl), { reason: 'Solve the CAPTCHA' })` and returns at once; `GET /link` returns the latest link; `GET /result` returns the result or 204.
  - `cdp-page.ts`: `createCdpPage(browserWsUrl, targetId)` → a Puppeteer-shaped page (`createCDPSession()` returning `{ send, on, detach }` over one CDP WebSocket with `Target.attachToTarget({ flatten: true })`, `on('close'|'popup')`, `url()`), standing in for `@cloudflare/puppeteer`, which `wrangler dev` can't reach offline.
- The test: Chromium (Playwright) with `--remote-debugging-port`, opens the fixture page; `wrangler dev` runs `agent-worker` (`--port` from `freePort`); POST `/run`; poll `/link`; a phone-sized Playwright context opens the link, taps Start, solves the fixture CAPTCHA, taps Done; poll `/result` until `{ status: 'resolved' }`; the agent page shows the solved state.

- [ ] **Step 1: Write `e2e/workers.test.ts`** with the flow above and a second case: `takeover` with `timeoutS: 5` and nobody opening the link → `timed_out`.

- [ ] **Step 2: Run** — `pnpm --filter @velmlabs/unstuck-engine build && pnpm --filter e2e exec vitest run workers.test.ts` → both PASS.

- [ ] **Step 3: Run the whole e2e suite** — `pnpm --filter e2e test` → PASS (Node, Python, MCP suites unchanged).

- [ ] **Step 4: Commit** — `git commit -m "test(e2e): takeover from a Durable Object under wrangler dev through relay-cloudflare"`

---

### Task 7: Release dry-run edge smoke test, docs touch-ups, 0.2.0

**Files:**
- Modify: `scripts/release.mjs` (new step after building `sdk-ts/dist`), version fields for every published package (follow what `scripts/release.mjs` bumps; `sdk-py` too if versions are kept in lockstep), `sdk-ts/README.md` (short "Cloudflare Workers" section: options-only config, Durable Object, `keep_alive: 600000`), `CHANGELOG.md` if present, `docs/roadmap/cloudflare-workers.md` (Phase 1 status ✅ once merged)
- Test: `scripts/release.test.mjs` if the release script has tests (else the dry run itself)

**Interfaces:**
- Consumes: `sdk-ts/dist/edge.js` (Task 4).
- Produces: `edgeSmoke(distDir: string): Promise<void>` in `scripts/release.mjs` — esbuild `bundle: true, platform: 'neutral', conditions: ['workerd', 'worker', 'import'], format: 'esm', write: false` from a stub `import { Unstuck } from '@velmlabs/unstuck'; export default { fetch() { return new Response(typeof Unstuck) } }` resolved against the clean-install folder; fails if the metafile lists any `node:` input or any builtin, or bundle > 1 MiB.

- [ ] **Step 1: Write the failing test** — `edgeSmoke` passes on the real dist and throws `/node:child_process/` on a fixture package whose `workerd` export imports `node:child_process`.

- [ ] **Step 2: Run** — `pnpm test:scripts` → FAIL, then implement, then PASS.

- [ ] **Step 3: Bump to 0.2.0 and run the dry run** — `pnpm release` → `✓ dry run passed for <sha>` with the edge smoke line in its output.

- [ ] **Step 4: Full suite** — `pnpm test && pnpm check:runtime` → PASS, coverage ≥ 90% everywhere.

- [ ] **Step 5: Commit** — `git commit -m "release: 0.2.0 with in-process mode for Workers, Deno and Bun"`

- [ ] **Step 6: Stop for the user** — manual Browser Rendering check on staging (deploy `e2e/workers/agent-worker.ts` with `@cloudflare/puppeteer` and a `BROWSER` binding, run one takeover from a phone), then publishing and merge to `main` only with their go-ahead.
