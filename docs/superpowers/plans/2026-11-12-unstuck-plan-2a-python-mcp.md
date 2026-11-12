# Unstuck Plan 2a: Python SDK, MCP server, direct CDP, capabilities, popups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Python agent (`await unstuck.takeover(page, reason=...)`) and any MCP client (tool `request_human_takeover`) get the same takeover Plan 1 gives TypeScript; every browser is capability-checked on attach, with fallbacks; and popups a CAPTCHA opens are followed.

**Architecture:** The Python SDK is a thin port of `sdk-ts` that drives the same engine binary over the same JSON-lines protocol; shared protocol test cases keep both peers identical. The engine gains a direct CDP client (connect by CDP URL, used by MCP mode and `doctor`), an MCP stdio server mode, a capability probe in core with screenshot-polling and per-character-typing fallbacks, and a session-level "active target" that switches to popups and back.

**Tech Stack:** Python ≥ 3.10, uv, pytest + pytest-asyncio + pytest-cov, Playwright for Python 1.63.0 (matches the pre-installed browsers); TypeScript side unchanged from Plan 1 plus `@modelcontextprotocol/sdk` 1.x and `pngjs` 7.

**Spec:** `docs/superpowers/specs/2026-11-12-unstuck-mvp-design.md` (§4.4, §5, §10; §7 detection and §6 watch mode are Plan 2b).

## Global Constraints

- Everything in Plan 1's Global Constraints still applies (names, licenses, runtime-agnostic packages, 127.0.0.1 default, token in fragment, single viewer, binary newest-only frames, private event log, protocol version **1**).
- **Test coverage > 90%** in every package, now including `sdk-py` (`pytest --cov=unstuck --cov-fail-under=90`).
- **No AI attribution** in commits or PRs; commit as `Velm Labs <velmlabs@users.noreply.github.com>` (see `CLAUDE.md`).
- Python package: PyPI `unstuck`, import `unstuck`, license Apache-2.0, Python ≥ 3.10, async API only (Playwright async / browser-use are async).
- Python errors and results mirror TypeScript: `UnstuckEngineError`, `PageClosedError`, `TakeoverResult(status, session_id, url, duration_s, detail)`; `takeover()` never raises for page close (returns `failed`/`page_closed`); engine handshake timeout **15 s**; every engine error names `UNSTUCK_ENGINE_PATH`.
- Engine binary lookup order (both SDKs): explicit option → `UNSTUCK_ENGINE_PATH` → bundled binary (Python: `unstuck/_bin/unstuck-engine`, shipped in Plan 6 wheels).
- MCP tool name **`request_human_takeover`**, params `reason` (required), `cdp_url`, `target_id`, `timeout_s`; blocks until the takeover ends; returns the result as JSON text.
- Capability fallbacks (spec §4.4): no screencast → poll `Page.captureScreenshot` at **5 fps**; no `Input.insertText` → per-character `Input.dispatchKeyEvent`; no input → `failed` with detail `browser does not support input`.
- Probes on a user's page must have **no visible side effects**: `Page.startScreencast`/`stopScreencast`, `Input.insertText` with `''`, `Input.dispatchMouseEvent` `mouseMoved` at the current pointer (0,0). Probes that need fixture pages (cross-origin iframe paint, popup tracking) run only in `unstuck-engine doctor`.

## Review Focus

1. **Python agent process must exit after `takeover()` + `close()`**, even when the takeover timed out or the engine was killed: no orphaned engine process, no pending asyncio task warnings. → Task 4 test.
2. **MCP client that never sees the link**: in MCP mode the human must still be able to get the link before the tool returns (stderr line, MCP logging notification, optional `--open` to open it locally). → Task 9 test.
3. **CDP URL given in any common form** (`http://127.0.0.1:9222`, `ws://…/devtools/browser/<id>`, bare `127.0.0.1:9222`) and a browser with several tabs: the takeover must attach to the requested `target_id`, else the most recently focused page, never a service worker or devtools target. → Task 6 tests.
4. **A CAPTCHA that opens a popup and then closes it**: the human's stream follows the popup and returns to the original page when it closes; input goes to whichever page is shown. → Task 8 test.
5. **A browser without screencast or insertText** (Obscura-like, hosted browsers): the takeover still works through the fallbacks, and the capability report says which fallback was used. → Task 7 tests.

---

## File map

```
protocol/cases/rpc.json                     shared RPC conformance cases (TS + Python)
protocol/test/cases.test.ts                 runs the cases against createRpcPeer
sdk-py/pyproject.toml, LICENSE, README.md
sdk-py/src/unstuck/{__init__.py, _rpc.py, _engine.py, _attach.py, _client.py, _errors.py, _types.py, _version.py}
sdk-py/tests/{conftest.py, test_rpc_cases.py, test_engine.py, test_attach.py, test_client.py, test_e2e.py}
core/src/capabilities.ts                    probeCapabilities()
core/src/stream/poll.ts                     screenshot-polling frame source
core/src/stream/input.ts                    (modify) per-character fallback
core/src/session/takeover.ts                (modify) capabilities, active target, popups
engine/src/direct-cdp.ts                    connectCdp(url, targetId?)
engine/src/doctor.ts                        runDoctor(cdpUrl) → report
engine/src/mcp.ts                           runMcpServer()
engine/src/cli.ts                           (modify) --mcp, doctor subcommand
sdk-ts/src/unstuck.ts, attach.ts            (modify) forward popups
examples/playwright-py/main.py
```

---

### Task 1: Shared protocol conformance cases

**Files:** Create `protocol/cases/rpc.json`, `protocol/test/cases.test.ts`.

**Interfaces:**
- Produces: `protocol/cases/rpc.json`: `{ "cases": [ { "name": string, "steps": Step[] } ] }` where `Step` is one of
  `{"handle": method, "returns": any}` · `{"handle": method, "throws": {"code"?: string, "message": string}}` ·
  `{"request": method, "params"?: any, "expect": {"result": any} | {"error": {"code": string}}}` ·
  `{"receive": rawLine}` (fed to the peer, must not throw) · `{"close": reason, "then_request": method, "expect": {"error": {"code": "closed"}}}`.
  The runner wires two peers back to back; `handle` steps register on peer B, `request` steps run from peer A.

- [ ] **Step 1: Write the cases and the TS runner.** At least these cases: request→result (`"x"` returns `2`); async handler; `unknown_method`; `handler_error` with message; handler error with own code `protocol_mismatch`; malformed lines `"not json"`, `"42"`, `"{\"id\":999,\"result\":1}"` ignored; request after `close("gone")` → `closed`; result `null` when handler returns nothing. The runner asserts each `expect`.
- [ ] **Step 2: Run.** `pnpm --filter @unstuck/protocol test`. Expected: PASS (the TS peer already implements these; this task fixes the contract both SDKs must meet). Any failure is a TS bug: fix it with the case as the failing test.
- [ ] **Step 3: Commit.** `git commit -m "test(protocol): shared RPC conformance cases"`

### Task 2: Python package scaffold + RPC peer

**Files:** Create `sdk-py/pyproject.toml` (hatchling; `name="unstuck"`, `requires-python=">=3.10"`, dev deps `pytest`, `pytest-asyncio`, `pytest-cov`, `playwright==1.63.0`), `sdk-py/LICENSE` (Apache), `sdk-py/src/unstuck/{__init__.py,_rpc.py,_errors.py,_types.py,_version.py}`, `sdk-py/tests/test_rpc_cases.py`, `sdk-py/tests/conftest.py`. Add `[tool.pytest.ini_options] asyncio_mode="auto"` and `[tool.coverage.report] fail_under=90`. Root `package.json` `test` script also runs `cd sdk-py && uv run pytest`.

**Interfaces:**
- Produces (`unstuck._rpc`): `class RpcCallError(Exception)` with `.code: str`; `class RpcPeer` with `__init__(self, write: Callable[[str], None])`, `async request(method: str, params: Any = None) -> Any`, `notify(method, params=None) -> None`, `handle(method, fn: Callable[[Any], Any | Awaitable[Any]])`, `on_notification(method, fn: Callable[[Any], None])`, `receive(line: str) -> None`, `close(reason: str) -> None`. Same semantics as `protocol/src/rpc.ts` (codes `unknown_method`, `handler_error`, pass-through `code`, `closed`; result `None` serialised as `null`). JSON lines use compact separators (`json.dumps(msg, separators=(",", ":"), ensure_ascii=False)`).
- `unstuck._errors`: `UnstuckEngineError(Exception)` with `.engine_path: str | None`; `PageClosedError(Exception)`.
- `unstuck._types`: `@dataclass(frozen=True) TakeoverResult(status: Literal["resolved","timed_out","cancelled","failed"], session_id: str, url: str, duration_s: float, detail: str | None = None)` with `@classmethod from_wire(d: dict)` mapping camelCase; `@dataclass(frozen=True) TakeoverLink(url, reason, session_id, expires_at: int)`.
- `PROTOCOL_VERSION = 1`, `__version__ = "0.1.0"`.

- [ ] **Step 1: Write `tests/test_rpc_cases.py`** that loads `../../protocol/cases/rpc.json` and runs every case with two `RpcPeer`s wired through `asyncio.get_running_loop().call_soon` (parametrised by case name), plus unit tests for `TakeoverResult.from_wire({"status":"failed","sessionId":"s","url":"u","durationS":1.5,"detail":"page_closed"})`.
- [ ] **Step 2: Run.** `cd sdk-py && uv run pytest tests/test_rpc_cases.py`. Expected: FAIL (`unstuck._rpc` missing).
- [ ] **Step 3: Implement** the modules above.
- [ ] **Step 4: Run.** Same command with `--cov=unstuck`. Expected: PASS, coverage ≥ 90%.
- [ ] **Step 5: Commit.** `git commit -m "feat(sdk-py): package scaffold and RPC peer passing shared cases"`

### Task 3: Python engine process

**Files:** Create `sdk-py/src/unstuck/_engine.py`, `sdk-py/tests/test_engine.py` (fake engines are small Python scripts written to `tmp_path`, `#!{sys.executable}`, chmod 755).

**Interfaces:**
- Consumes: `RpcPeer`, `UnstuckEngineError`.
- Produces: `resolve_engine_path(engine_path: str | None, env: Mapping[str, str] = os.environ) -> str` (bundled path `Path(unstuck.__file__).parent / "_bin" / ("unstuck-engine.exe" if win else "unstuck-engine")` when it exists); `class EngineProcess` with `peer: RpcPeer`, `engine_version: str`, `async wait() -> int | None`, `kill() -> None`; `async spawn_engine(path: str, *, host: str | None = None, port: int | None = None, handshake_timeout_s: float = 15.0) -> EngineProcess` using `asyncio.create_subprocess_exec(path, "--stdio", ..., stdin=PIPE, stdout=PIPE, stderr=None)` and a reader task feeding `peer.receive`. Messages match the TS SDK word for word (`could not start the Unstuck engine at {path}: …`, `… exited with code {n} before the handshake. …`, `… did not answer the handshake within {t} s. …`, `… refused the handshake: … .`), each ending with `Set UNSTUCK_ENGINE_PATH to a working unstuck-engine binary.`

- [ ] **Step 1: Write tests**: lookup order (explicit → env → bundled → error naming all three and `UNSTUCK_ENGINE_PATH`); real engine (`../engine/dist/unstuck-engine`) handshake returns a semver version; `--host/--port` passed through (fake echoes argv); missing binary → `UnstuckEngineError` with path, < 2 s; exit before hello (exit 3) → message contains `exited with code 3 before the handshake`; silent engine with `handshake_timeout_s=0.3` → `did not answer the handshake within 0.3 s`, child killed; protocol mismatch → `refused the handshake`.
- [ ] **Step 2: Run** `uv run pytest tests/test_engine.py`. Expected: FAIL.
- [ ] **Step 3: Implement.** On reader EOF call `peer.close(f"engine exited with code {code}")`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(sdk-py): engine process with handshake timeout"`

### Task 4: Python attach + `Unstuck` client

**Files:** Create `sdk-py/src/unstuck/_attach.py`, `_client.py`; export from `__init__.py`; tests `test_attach.py`, `test_client.py` (Playwright async, real Chromium, real engine).

**Interfaces:**
- Produces (`_attach`): `class AttachedPage` with `page_id: str`, `url() -> str`, `async send(method, params=None)`, `subscribe(event, cb)`, `on_close(cb)` (fires immediately if already closed), `async detach()`; `async attach_page(page) -> AttachedPage` (Playwright async `Page`: `await page.context.new_cdp_session(page)`, close via `page.on("close")`/`page.on("crash")`, `page.is_closed()` checked first → `PageClosedError`; any other object → `TypeError("Unsupported page object: pass a Playwright Page")`).
- Produces (`_client`): `class Unstuck` with `__init__(self, *, engine_path=None, host=None, port=None, timeout_s=None, on_link: Callable[[TakeoverLink], None] | None = None)`, `async takeover(self, page, *, reason: str, timeout_s: int | None = None) -> TakeoverResult`, `async close(self) -> None`, `async __aenter__/__aexit__` (close on exit). Behaviour mirrors `sdk-ts/src/unstuck.ts` after the Plan 1 fixes: fresh CDP session per takeover; close watched from attach; already-closed or closing-while-starting page → `TakeoverResult(status="failed", session_id="", url="", duration_s=0, detail="page_closed")`; engine exit mid-takeover → `UnstuckEngineError("engine exited with code N")` and respawn next call; default `on_link` prints `Unstuck: a human is needed ({reason}) → {url}` to stderr; `close()` sends `shutdown`, waits 2 s, then kills.

- [ ] **Step 1: Write tests** mirroring `sdk-ts/test/attach.test.ts` and `unstuck.test.ts` one for one (names prefixed `test_`), plus **Review Focus 1**: a child `python -c` script runs `takeover(page, reason="x", timeout_s=1)`, then `await unstuck.close()` and `await browser.close()`; it must print `timed_out` and exit 0 within 15 s with no `Task was destroyed but it is pending` in stderr; and a variant where the engine is killed mid-takeover still exits 0 after catching `UnstuckEngineError`.
- [ ] **Step 2: Run** `uv run pytest tests/test_attach.py tests/test_client.py`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole Python suite with coverage. Expected: PASS, ≥ 90%.
- [ ] **Step 5: Commit.** `git commit -m "feat(sdk-py): Unstuck client and Playwright attach"`

### Task 5: Python end to end + example

**Files:** Create `sdk-py/tests/test_e2e.py`, `examples/playwright-py/main.py`, `sdk-py/README.md`; modify root `README.md` (Python quickstart).

- [ ] **Step 1: Write `test_e2e.py`**: agent page 1280×720 on the Plan 1 fixture (`e2e/fixtures/fake-captcha.html` served by `http.server` in a thread); human = Playwright Python context with `p.devices["iPhone 13"]`; human taps `#robot` through the canvas (same letterbox math as `e2e/local-takeover.test.ts`), taps Done → `resolved`, `await page.evaluate("window.clicks") == 1`.
- [ ] **Step 2: Run** `uv run pytest tests/test_e2e.py`. Expected: PASS (all pieces exist).
- [ ] **Step 3: Write the example** (async Playwright, prints the link, awaits takeover) and the Python quickstart; run the example with a scripted human as in Plan 1 Task 12 and record the exit code 0.
- [ ] **Step 4: Commit.** `git commit -m "test(sdk-py): end to end takeover; Python example and docs"`

### Task 6: Engine direct CDP client

**Files:** Create `engine/src/direct-cdp.ts`, `engine/test/direct-cdp.test.ts` (launches Chromium with `--remote-debugging-port=0` via the pre-installed Playwright and reads the port from `DevToolsActivePort`).

**Interfaces:**
- Produces: `normalizeCdpUrl(input: string): string` (accepts `http(s)://host:port`, `host:port`, `ws(s)://…/devtools/browser/<id>`; returns an `http://host:port` base or the given `ws` URL); `connectCdp(url: string, opts?: {targetId?: string; fetchImpl?: typeof fetch}): Promise<CdpClient & {targetId: string; close(): Promise<void>; browser: BrowserCdp}>`. Resolves `ws` via `GET /json/version`, opens one WebSocket, `Target.attachToTarget {targetId, flatten: true}`, routes commands/events by `sessionId`. Target choice: `targetId` if given (error `target <id> not found` otherwise), else the first `type === "page"` target whose URL is not `devtools://` (Chrome lists the most recently active first). `onClose` fires on `Target.detachedFromTarget`/`targetDestroyed` for that target or WebSocket close. `BrowserCdp` = `{ send(method, params), on(event, cb) }` at browser level (for popups, Task 8).

- [ ] **Step 1: Write tests**: **Review Focus 3**: all three URL forms connect; with three tabs and a service worker present, `targetId` picks the right tab and the default picks a page tab; `Runtime.evaluate` works through the session; closing the tab fires `onClose('target closed')`; unknown `targetId` rejects with `target … not found`; `close()` closes the socket.
- [ ] **Step 2: Run** `pnpm --filter @unstuck/engine test -- direct-cdp`. Expected: FAIL.
- [ ] **Step 3: Implement** with `ws`.
- [ ] **Step 4: Run.** Expected: PASS; engine coverage ≥ 90%.
- [ ] **Step 5: Commit.** `git commit -m "feat(engine): direct CDP client"`

### Task 7: Capability probe + fallbacks

**Files:** Create `core/src/capabilities.ts`, `core/src/stream/poll.ts`; modify `core/src/stream/input.ts`, `core/src/session/takeover.ts`; tests `core/test/capabilities.test.ts`, `core/test/poll.test.ts`, additions to `input.test.ts` and `takeover.test.ts`.

**Interfaces:**
- Produces: `type Capabilities = { screencast: boolean; insertText: boolean; input: boolean }`; `probeCapabilities(cdp: CdpClient, opts?: {timeoutMs?: number /* 3000 */}): Promise<Capabilities>`: screencast = `Page.startScreencast` then `Page.stopScreencast` both succeed; insertText = `Input.insertText {text: ''}` succeeds; input = `Input.dispatchMouseEvent {type:'mouseMoved', x:0, y:0}` succeeds; any method erroring or exceeding the timeout counts as unsupported.
- `startScreenshotPolling(cdp, onFrame, opts?: {fps?: number /* 5 */; quality?: number /* 70 */}): Promise<() => Promise<void>>`: same contract as `startScreencast`; frame size from `Page.getLayoutMetrics().cssVisualViewport` (`clientWidth/clientHeight`), JPEG from `Page.captureScreenshot {format:'jpeg', quality}`; never overlaps two captures.
- `applyInput(cdp, msg, caps?: Capabilities)`: when `caps.insertText === false`, `{t:'text'}` becomes one `keyDown` (with `text`) + `keyUp` per Unicode code point.
- Session: probe once before publishing; if `!caps.input` → finish `failed` with detail `browser does not support input`; pick screencast or polling; log `capabilities` on the `created` event as `{screencast, insertText, input}` booleans; append `; fallback: screenshots` / `; fallback: per-key typing` to `result.detail` only when a fallback was used and the status is otherwise detail-less.

- [ ] **Step 1: Write tests** (FakeCdp responders that reject specific methods): probe true/false per method and on timeout; polling emits frames at the requested fps with CSS sizes and stops cleanly; per-character fallback for `'héllo 日本'` sends 8 keyDown/keyUp pairs; **Review Focus 5**: a FakeCdp without screencast or insertText still completes a takeover (frames reach the viewer via polling, text arrives as keys) and `result.detail` is `fallback: screenshots, per-key typing`; no-input browser → `failed`/`browser does not support input` before any link is published.
- [ ] **Step 2: Run** `pnpm --filter @unstuck/core test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** core tests and `node scripts/check-runtime-agnostic.mjs core/src`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(core): capability probe with screenshot and per-key fallbacks"`

### Task 8: Popup following

**Files:** Modify `core/src/session/takeover.ts`, `core/src/engine.ts` (new option), `protocol/src/rpc-types.ts` (new notifications), `engine/src/stdio-host.ts`, `engine/src/direct-cdp.ts`, `sdk-ts/src/attach.ts`, `sdk-ts/src/unstuck.ts`, `sdk-py/src/unstuck/_attach.py`, `_client.py`; tests in each package plus an e2e case.

**Interfaces:**
- Core: `Engine.takeover(cdp, opts & { popups?: PopupSource })` where `PopupSource = { onPopup(cb: (popup: CdpClient) => void): () => void }`. The session keeps a stack of active targets: a popup becomes active (screencast moves to it, input goes to it, the viewer gets its frames); when it closes, the previous target becomes active again. The page-close rule applies only to the original page.
- Protocol: SDK→engine notification `page.popup {pageId, popupPageId}` (the SDK has already attached the popup and serves its `cdp.send`/`cdp.subscribe` under `popupPageId`); add to `Methods` as `pagePopup: 'page.popup'`.
- SDKs: Playwright `page.on('popup')` (TS and Python) / Puppeteer `page.on('popup')` attach the popup and notify while a takeover runs.
- Direct CDP: `PopupSource` built from browser-level `Target.setDiscoverTargets` + `targetCreated` events whose `openerId` is the attached target.

- [ ] **Step 1: Write tests.** Core: with a FakeCdp popup emitted mid-session, `Page.startScreencast` is called on the popup, input goes to the popup, closing the popup returns the stream and input to the page, closing the popup does not fail the session. **Review Focus 4** e2e (TS): fixture button `window.open('/popup')` where the popup has a "Verify" button that sets `window.opener.verified = true` and closes itself; the human clicks the opener button, sees the popup, clicks Verify, sees the original page again, taps Done → `resolved` and `verified === true`. Python and direct-CDP: one test each that the popup is attached and reported.
- [ ] **Step 2: Run** the affected suites. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test` (all packages, Python included). Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: follow popups during a takeover"`

### Task 9: MCP server mode

**Files:** Create `engine/src/mcp.ts`, `engine/test/mcp.test.ts`; modify `engine/src/cli.ts` (`--mcp`, `--open`), `engine/package.json` (`@modelcontextprotocol/sdk`).

**Interfaces:**
- Produces: `createMcpServer(opts: { transport: Transport; log?: EventLog; env: Record<string,string|undefined>; openUrl?: (url: string) => void; connect?: typeof connectCdp; stderr: { write(s: string): unknown } }): McpServer` registering tool `request_human_takeover` with input schema `{ reason: string; cdp_url?: string; target_id?: string; timeout_s?: number (10..3600) }`. `cdp_url` falls back to `UNSTUCK_CDP_URL`; missing both → tool error `No browser to take over: pass cdp_url or set UNSTUCK_CDP_URL`. The tool connects with `connectCdp`, runs `engine.takeover` with a `PopupSource` from the direct client, and returns `{ content: [{ type: 'text', text: JSON.stringify({ status, session_id, url, duration_s, detail }) }], isError: status === 'failed' }`.
- **Review Focus 2**, link delivery before the tool returns: stderr line `Unstuck: a human is needed (<reason>) → <url>`; an MCP logging notification (level `notice`, same text); and `openUrl(url)` when started with `--open` (default implementation spawns `xdg-open`/`open`/`start` detached).
- CLI: `unstuck-engine --mcp [--open] [--host] [--port]` runs the server on stdio (`StdioServerTransport`); `main()` returns when stdin closes.

- [ ] **Step 1: Write tests** using the SDK's in-memory client/server pair: tool listed with that exact name and schema; a call with `cdp_url` of a real Chromium (Task 6 helper) produces a logging notification containing the URL before the result; a scripted human taps Done → result JSON `status: "resolved"`; no URL anywhere → tool error text above; `--open` calls `openUrl` once with the link; a `target_id` that does not exist → `isError: true` with `target … not found`.
- [ ] **Step 2: Run** `pnpm --filter @unstuck/engine test -- mcp`. Expected: FAIL.
- [ ] **Step 3: Implement.** Rebuild the binary (`pnpm --filter @unstuck/engine build`).
- [ ] **Step 4: Run** the engine suite. Expected: PASS, ≥ 90%.
- [ ] **Step 5: Commit.** `git commit -m "feat(engine): MCP server with request_human_takeover"`

### Task 10: `unstuck-engine doctor`

**Files:** Create `engine/src/doctor.ts`, `engine/test/doctor.test.ts`; modify `engine/src/cli.ts` (`doctor --cdp <url>`), `engine/package.json` (`pngjs`).

**Interfaces:**
- Produces: `runDoctor(cdpUrl: string, opts?: { connect?: typeof connectCdp }): Promise<DoctorReport>` where `DoctorReport = { browser: string; capabilities: Capabilities; crossOriginIframePaint: boolean | 'unknown'; popupTracking: boolean | 'unknown'; verdict: 'full' | 'limited' | 'unsupported'; notes: string[] }` and `formatReport(r): string` (one line per check, ✓/✗/?, then the verdict and notes). The paint check opens a new tab (`Target.createTarget`) on `http://127.0.0.1:<a>/` that iframes `http://localhost:<b>/` (two local servers, the child filled `#00ff00`), screenshots as PNG, and checks the pixel at the iframe centre with `pngjs`; the popup check uses `window.open` from that tab and waits 3 s for `targetCreated` with the opener. Verdict: `unsupported` if `!input`; `limited` if paint is false (note: "CAPTCHA widgets in cross-origin iframes will not be visible; use Chromium for CAPTCHAs"); else `full`. The doctor closes every tab it opened.

- [ ] **Step 1: Write tests**: against real Chromium the verdict is `full` with all ✓; with a fake `connect` whose screenshot is all white the verdict is `limited` with the note; with input unsupported → `unsupported`; tabs opened by the doctor are closed afterwards (`Target.getTargets` count unchanged); CLI `doctor --cdp` prints the formatted report and exits 0 (`full`/`limited`) or 1 (`unsupported`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the engine suite and, if `obscura` is available in the sandbox (Plan 1 Task 1 download), run `doctor` against it and paste the report into `docs/spikes/obscura.md`. Expected: suite PASS; Obscura verdict `limited`.
- [ ] **Step 5: Commit.** `git commit -m "feat(engine): doctor capability report"`

### Task 11: Docs, MCP config, full verification

**Files:** Modify root `README.md` (Python and MCP sections), `docs/superpowers/plans/2026-11-12-unstuck-plan-1-foundation.md` roadmap (mark Plan 2 split into 2a/2b).

- [ ] **Step 1: README.** Python quickstart (commands run in Task 5); MCP section with a Claude Desktop / Claude Code config block:
  `{"mcpServers": {"unstuck": {"command": "/path/to/unstuck-engine", "args": ["--mcp", "--open"], "env": {"UNSTUCK_CDP_URL": "http://127.0.0.1:9222"}}}}` and how to start Chrome with `--remote-debugging-port=9222`; `doctor` usage.
- [ ] **Step 2: Full verification.** `pnpm -r build && pnpm test && node scripts/check-runtime-agnostic.mjs protocol/src core/src viewer/src`, typecheck every package, `cd sdk-py && uv run pytest --cov=unstuck`. Expected: all PASS, every package ≥ 90%.
- [ ] **Step 3: Commit.** `git commit -m "docs: Python and MCP quickstarts"`

---

## Roadmap update

| Plan | Scope |
|---|---|
| **2a** (this plan) | Python SDK, MCP server, direct CDP, capability probe + fallbacks, doctor, popups |
| **2b** | Rule packs (§7.1), `watch()` in both SDKs with agent pause, fixture widgets + official test sitekeys, `browser_cannot_render_captcha` for Limited browsers |
| 3–6 | Unchanged (relay + encryption, notifiers, Workers/Astro/web component, release) |
