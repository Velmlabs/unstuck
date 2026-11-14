# Native typing on the mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tapping a field in the mirrored page opens the right phone keyboard on the first tap, and every key the person presses (held Backspace, Shift combos, Return/Go, Tab, arrows…) reaches the agent's real page.

**Architecture:** The engine scans the shown target for visible editable fields and sends a field map (rectangles + kinds, never values) inside the existing encrypted stream; after taps it reports what took focus. The viewer hit-tests taps against the map, focuses a full-size invisible "bridge" input positioned over the tapped field on pointer release, and forwards key presses first (with modifiers) and text events as the fallback.

**Tech Stack:** TypeScript, TypeBox (protocol), CDP `Runtime.evaluate` + `Input.dispatchKeyEvent` (core), Preact (viewer), vitest (+ Playwright Chromium for in-browser tests), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-11-14-native-typing-design.md` (spike evidence: iPad Safari 18.7 logs in the conversation; spike at https://unstuck-keyboard-spike.zeandcode.workers.dev, lab at `/hold`).

## Global Constraints

- New engine → viewer messages only: `{ t: 'fields', fields: Field[] }`, `{ t: 'focus', kind: FieldKind | null }`; `FieldKind = 'text' | 'numeric' | 'otp' | 'email' | 'password'`; `Field = { x: number; y: number; w: number; h: number; kind: FieldKind }` in CSS px of the streamed viewport, integers.
- No change to viewer → engine messages (the engine validates `hello` strictly; 0.1.x engines must keep working with the new cloud-served viewer).
- A field's value is never read or sent.
- Field map: at most 30 fields, nearest the viewport centre first; sent only when changed, re-sent every 5 s; scans at most every 500 ms on frames, immediately after each mouse up, wheel or key input and on target change.
- Bridge: full size over the field (min 44×32 CSS px), `color`/`caret-color`/`background` transparent, no border/outline, `pointer-events: none`, `font-size: 16px`, inside a `<form>`, `enterkeyhint="go"`, `autocorrect="off"`, `autocapitalize="off"`, `spellcheck="false"`; reserve of 64 × U+200B with the caret at the end, refilled below 16.
- Bridge attributes per kind: otp → inputmode `numeric`, autocomplete `one-time-code`; numeric → `numeric`, `off`; email → `email`, `off`; password → `text`, `off`, type `password`; text → `text`, `off`. Type is `text` except password.
- Focus on `pointerup` when the pointer moved < 10 px since `pointerdown`.
- Code splitting: in `otp`/`numeric` fields, one-piece text becomes key presses only if ≤ 12 characters with no whitespace; otherwise one `text` message.
- Shortcut translation table: the spec's "Shortcuts follow the agent browser's system" table, verbatim.
- Coverage > 90% in every package; `protocol/`, `core/`, `viewer/` import no Node built-ins in `src/`.
- Commit as `Velm Labs <velmlabs@users.noreply.github.com>`, no AI attribution.

## Review Focus

1. The page scrolls between the last map and the tap (stale map): a wheel input triggers an immediate rescan. (Task 3 test `rescans right after a wheel input`.)
2. A tap on a mapped field that the page doesn't actually focus: `focus: null` blurs the bridge so no keyboard sits over a non-field. (Task 5 test `focus null after a mapped tap closes the keyboard`.)
3. A password or code typed through the bridge must not linger in the viewer: after any input the bridge holds only the reserve. (Task 4 test `never keeps typed text`.)
4. An older engine that never sends `fields`: the Keyboard button still works, with the bridge placed over the bottom of the mirror. (Task 5 test `without a field map the Keyboard button still opens the bridge`.)
5. The scan fails (page navigating, CSP-blocked evaluate, detached frame): the takeover carries on, no `fields` message, no error to the viewer. (Task 3 test `a failing scan never fails the takeover`.)

---

### Task 1: Protocol messages

**Files:**
- Modify: `protocol/src/viewer.ts` (`EngineToViewerSchema`, `EngineToViewer`)
- Test: `protocol/test/viewer.test.ts`

**Interfaces:**
- Produces: `export type FieldKind`, `export type Field`, `export const FieldKinds = ['text','numeric','otp','email','password'] as const`, `FieldSchema`; `EngineToViewer` gains `{ t: 'fields'; fields: Field[] }` and `{ t: 'focus'; kind: FieldKind | null }`.

- [ ] **Step 1: Failing tests.** `Value.Check(EngineToViewerSchema, { t: 'fields', fields: [{ x: 1, y: 2, w: 3, h: 4, kind: 'otp' }] })` is true; with `kind: 'date'` false; `{ t: 'focus', kind: null }` and `{ t: 'focus', kind: 'email' }` true; `fields` with 31 entries false (`maxItems: 30`).
- [ ] **Step 2:** `pnpm --filter @velmlabs/unstuck-protocol test` → the new cases fail.
- [ ] **Step 3:** Add the schemas and types.
- [ ] **Step 4:** Tests pass, coverage > 90%.
- [ ] **Step 5:** Commit `feat(protocol): fields and focus messages for native typing`.

### Task 2: Field scanner (in-page)

**Files:**
- Create: `core/src/stream/fields.ts`
- Test: `core/test/fields.browser.test.ts` (Playwright Chromium, `page.setContent` fixtures), `core/test/fields.test.ts` (FakeCdp)

**Interfaces:**
- Consumes: `Field`, `FieldKind` (Task 1).
- Produces: `scanFields(cdp: CdpClient): Promise<Field[]>`; `focusedKind(cdp: CdpClient): Promise<FieldKind | null>`; `export const SCAN_SOURCE: string` (the function evaluated in the page, `returnByValue: true`), `export const FOCUS_SOURCE: string`.

- [ ] **Step 1: Failing browser tests** (evaluate `SCAN_SOURCE` in a 390×844 page):
  - classifies `autocomplete=one-time-code` → `otp`; `type=tel`, `type=number`, `inputmode=numeric|decimal|tel` → `numeric`; `type=email`, `inputmode=email` → `email`; `type=password` → `password`; plain input, `textarea`, `contenteditable` → `text`;
  - skips `display:none`, `visibility:hidden`, `disabled`, `readonly`, zero-size, fully off-viewport;
  - keeps an `opacity:0` input stretched over six drawn boxes;
  - skips a field covered by a fixed banner (`elementFromPoint` at its centre is the banner);
  - finds fields in a same-origin iframe offset by the iframe's position, and in an open shadow root;
  - returns integers, at most 30, nearest the viewport centre first;
  - never contains a `value` key (assert `Object.keys` of every field is exactly `['x','y','w','h','kind']`).
  - `FOCUS_SOURCE`: an email input focused → `'email'`; body focused → `null`; a cross-origin iframe focused → `'text'` (use `srcdoc` iframe with `sandbox` without `allow-same-origin`).
- [ ] **Step 2: Failing unit tests** with FakeCdp: `scanFields` returns `[]` when `Runtime.evaluate` throws or returns `exceptionDetails`; passes `returnByValue: true`.
- [ ] **Step 3:** Implement. Write the in-page functions as plain JS strings (no closures over module scope).
- [ ] **Step 4:** `pnpm --filter @velmlabs/unstuck-core test` passes; coverage > 90%.
- [ ] **Step 5:** Commit `feat(core): scan the shown page for typable fields (never their values)`.

### Task 3: Field feed in the takeover, and full key forwarding in the engine

**Files:**
- Create: `core/src/session/field-feed.ts`
- Create: `core/src/stream/shortcuts.ts` (`translateShortcut(msg: Extract<ViewerInput, { t: 'key' }>, browserIsMac: boolean): Extract<ViewerInput, { t: 'key' }>[]`, returning one or more key messages per the spec's table; `browserPlatformIsMac(cdp): Promise<boolean>` via `Runtime.evaluate('navigator.platform')`, cached per target, `false` on error)
- Modify: `core/src/session/takeover.ts` (create the feed in `attachViewer`, call it from the frame callback in `startStream`, from `handleInput`, from `switchStream`; stop it in `stopStream`/`finish`), `core/src/stream/input.ts` (`VIRTUAL_KEYS` adds Home 36, End 35, PageUp 33, PageDown 34, Insert 45, F1–F12 112–123; a printable ASCII letter or digit key gets `windowsVirtualKeyCode` = its upper-case char code)
- Test: `core/test/field-feed.test.ts` (fake timers, injected scan/focus), `core/test/takeover.test.ts`, `core/test/input.test.ts`

**Interfaces:**
- Consumes: `scanFields`, `focusedKind` (Task 2).
- Produces: `createFieldFeed(deps: { scan: () => Promise<Field[]>; focus: () => Promise<FieldKind | null>; send: (m: EngineToViewer) => void }): FieldFeed` with `onFrame(): void`, `onInput(msg: ViewerInput): void`, `onTargetChanged(): void`, `stop(): void`.

- [ ] **Step 1: Failing feed tests:**
  - first `onFrame` scans and sends `fields`; frames within 500 ms don't rescan; a frame after 500 ms rescans;
  - an unchanged map is not re-sent, except every 5 s;
  - `rescans right after a wheel input` (and after `key` and mouse `up`, not mouse `move`);
  - mouse `up` also calls `focus` and sends `{ t: 'focus', kind }`;
  - `onTargetChanged` rescans immediately; `stop` cancels timers and later results are dropped;
  - `a failing scan never fails the takeover`: scan rejects → nothing sent, no throw, next trigger scans again.
- [ ] **Step 2: Failing takeover test:** with FakeCdp responding to `Runtime.evaluate` with one `otp` field, a joined viewer receives `{ t: 'fields', … }` after the first frame; inputs still apply in order.
- [ ] **Step 3a: Failing shortcut tests** (`core/test/shortcuts.test.ts`), one per table row in both directions, plus: plain `a` with Shift unchanged; Option+K (text `˚`) unchanged; keyup messages translated consistently with their keydown; Cmd+Backspace → two key presses (Shift+Home, Backspace). Takeover test: with `navigator.platform` answering `Linux x86_64`, a viewer's Cmd+A reaches `Input.dispatchKeyEvent` with modifiers 2 (Ctrl).
- [ ] **Step 3: Failing input tests:** `Home` → `windowsVirtualKeyCode: 36`; `F5` → 116; key `a` with text → `windowsVirtualKeyCode: 65`; `7` → 55.
- [ ] **Step 4:** Implement; scans run outside `inputChain` so a slow scan never delays input.
- [ ] **Step 5:** `pnpm --filter @velmlabs/unstuck-core test` passes; coverage > 90%.
- [ ] **Step 6:** Commit `feat(core): send the field map and focus to the viewer; virtual key codes for every key`.

### Task 4: The keyboard bridge (viewer)

**Files:**
- Create: `viewer/src/bridge.ts`
- Test: `viewer/test/bridge.test.ts` (jsdom, dispatched `KeyboardEvent`/`InputEvent`/`CompositionEvent`/`SubmitEvent`)

**Interfaces:**
- Consumes: `ViewerInput`, `FieldKind` (Task 1).
- Produces: `attachBridge(input: HTMLInputElement, form: HTMLFormElement, opts: { send: (m: ViewerInput) => void; kind: () => FieldKind | null; now?: () => number }): () => void` (returns detach); `configureBridge(input: HTMLInputElement, kind: FieldKind | 'text'): void` (attributes per the Global Constraints table, then refill the reserve); `RESERVE = 64`, `LOW = 16`.

- [ ] **Step 1: Failing tests:**
  - a printable `keydown` (`a`, Shift held) sends `{ t:'key', action:'down', key:'A', code:'KeyA', text:'A', modifiers: 8 }`, prevents default; its `keyup` sends `action:'up'`;
  - `Tab`, `Shift+Tab`, arrows, Home/End, PageUp/Down, Escape, Delete, `Enter`, F-keys, `Ctrl/Cmd+A` send key down/up with modifiers and prevent default; focus stays on the bridge after Tab;
  - modifier keys alone send nothing (down or up); `Ctrl/Cmd+C/V/X` are not prevented and send nothing;
  - plain `Backspace` keydown sends Backspace **without** preventing default; the following `beforeinput deleteContentBackward` within 50 ms sends nothing more and is not prevented; a `beforeinput deleteContentBackward` with no keydown (Android) sends one Backspace;
  - `deleteWordBackward`/`deleteSoftLineBackward` → one Backspace, prevented; `deleteContentForward` → Delete;
  - `keydown` with `key: 'Unidentified'` (keyCode 229) sends nothing; the following `beforeinput insertText "x"` sends `{ t:'text', text:'x' }`;
  - `insertReplacementText`, `insertFromPaste`, `insertFromDrop` (data from `dataTransfer`) send text;
  - for kind `otp` or `numeric`, text of length > 1 (`"482913"`) sends six key presses (down with `text`, up), not one `text` message; a 13-character or whitespace-containing paste (`"https://x.example/"`) sends one `text` message;
  - `compositionend "日本"` sends text once; `insertCompositionText` is not prevented;
  - form `submit` with no Enter key press in the last 300 ms sends Enter down/up once and refocuses; after an Enter key press it sends nothing;
  - `never keeps typed text`: after any of the above the input's value is only U+200B characters, ≥ 16 of them.
- [ ] **Step 2:** `pnpm --filter @velmlabs/unstuck-viewer test` → fail.
- [ ] **Step 3:** Implement (the spike's v5 logic, minus logging).
- [ ] **Step 4:** Tests pass; coverage > 90%.
- [ ] **Step 5:** Commit `feat(viewer): a keyboard bridge that forwards every key`.

### Task 5: Viewer wiring: map, tap-to-type, chip, keep the field in view

**Files:**
- Create: `viewer/src/fields.ts`
- Modify: `viewer/src/connection.ts` (`fields`/`focus` callbacks), `viewer/src/App.tsx` (replace today's bridge handlers with `attachBridge`; the bridge inside a `<form>` inside the mirror's container; pointer handling; chip; Keyboard button), `viewer/src/styles.css` (`.keyboard-bridge` per the Global Constraints; `.type-here` chip)
- Test: `viewer/test/fields.test.ts`, `viewer/test/App.test.tsx`, `viewer/test/connection.test.ts`

**Interfaces:**
- Consumes: `attachBridge`, `configureBridge` (Task 4); messages (Task 1).
- Produces: `hitField(fields: Field[], p: { x: number; y: number }): Field | null`; `bridgeBox(field: Field | null, canvas: DOMRect, page: { width: number; height: number }): { left: number; top: number; width: number; height: number }` (CSS px relative to the mirror container; `null` field → bottom strip of the mirror); `liftOffset(box, visualViewportHeight, containerTop): number` (px to shift the mirror up so the box sits above the keyboard, ≥ 0).

- [ ] **Step 1: Failing tests:**
  - `hitField` inside/outside/edges; `bridgeBox` scales page → CSS with letterboxing, applies the 44×32 minimum; `liftOffset` is 0 when the box is visible, positive when the keyboard covers it;
  - connection: a `fields` message reaches `onFields`, `focus` reaches `onFocus`; unknown types still ignored;
  - App: a tap (down+up, < 10 px) inside an `otp` field focuses the bridge in the `pointerup` handler with `inputmode=numeric`, `autocomplete=one-time-code`, positioned over the field; the tap is still sent as mouse down/up;
  - a drag of ≥ 10 px starting on a field doesn't focus; a tap outside all fields blurs;
  - `focus null after a mapped tap closes the keyboard`;
  - `focus: 'text'` while the bridge isn't focused shows a "Type here" chip; tapping it focuses the bridge (kind text, bottom strip); `focus: null` hides it;
  - `without a field map the Keyboard button still opens the bridge`;
  - while the bridge is focused and `visualViewport.height` shrinks below the field, the mirror container gets `transform: translateY(-<liftOffset>px)`; removed on blur.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm --filter @velmlabs/unstuck-viewer test` passes; coverage > 90%; `node scripts/check-runtime-agnostic.mjs protocol/src core/src viewer/src relay-core/src` passes.
- [ ] **Step 5:** Commit `feat(viewer): tap a field to type: the right keyboard on the first tap`.

### Task 6: End to end on a simulated phone

**Files:**
- Create: `e2e/fixtures/otp.html` (a single `autocomplete=one-time-code` input; a six-box widget: one `opacity:0` input over six drawn boxes; a variant of six `maxlength=1` inputs that move focus on `input`; an email input; a fixed cookie banner covering a text input; a Verify button that shows "ok" when the code is `482913`)
- Modify: `e2e/local-takeover.test.ts` (new `describe('native typing')`)

**Interfaces:**
- Consumes: everything above, through the built engine and viewer.

- [ ] **Step 1: Failing e2e tests** (Playwright iPhone 13 profile as the person, as the existing tests do):
  - tap the single code input → the bridge is focused with `inputmode=numeric` and `autocomplete=one-time-code`, within the field's rectangle on screen;
  - `insertText("482913")` on the bridge → the real page's code is `482913` in the single input and in both six-box variants; Verify shows "ok";
  - type `48`, press Backspace three times quickly with `repeat` → the real field is empty;
  - Shift+A in the email field → `A` in the real field, and the page saw `keydown` with `shiftKey`;
  - Tab from the email field → the real page's focus moved to the next field; the bridge is still focused;
  - a tap on the banner over a text input → the bridge is not focused;
  - Return → the real form submitted; Done → `resolved`.
- [ ] **Step 2:** `pnpm --filter @velmlabs/unstuck-engine build && pnpm test` → the new e2e tests fail before Tasks 1–5 are merged, pass after.
- [ ] **Step 3:** Full `pnpm test` green; coverage > 90% everywhere.
- [ ] **Step 4:** Commit `test(e2e): native typing on a simulated phone`.

### Task 7: Release 0.1.3 (owner-gated steps marked)

- [ ] **Step 1:** Bump 0.1.2 → 0.1.3 test-first as in previous releases; `pnpm test` green; commit `chore: 0.1.3`.
- [ ] **Step 2:** `pnpm release` (dry run) passes.
- [ ] **Step 3 (owner):** real-device check of the built viewer on the iPad (and Android if available) via a local or staging takeover: first-tap keyboard, held Backspace, Return/Go, SMS code suggestion, paste, Tab/arrows on a hardware keyboard.
- [ ] **Step 4 (owner go-ahead):** `pnpm release:publish`; verify from the public registries with a real takeover.
- [ ] **Step 5 (owner go-ahead):** cloud repo: `pnpm sync-vendor`, tests, deploy staging + smoke, then production (the hosted relay serves the new viewer); push both repos; delete the spike Worker `unstuck-keyboard-spike`.
