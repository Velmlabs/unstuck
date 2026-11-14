# Native typing on the mirror — design

Status: draft for owner review · 2026-11-14

## Why

Two-step codes, PINs and Cloudflare Zero Trust email codes are the most common reasons an agent hands over to a person. They already work in a takeover: the person sees the agent's live page and every key they type goes straight into the real field. But on a phone it is clumsy: they tap the field, nothing happens, they find the **Keyboard** button, and get a letter keyboard for a 6-digit code.

Goal: the person taps the field on the mirrored page and the right keyboard opens at once, a number pad for codes and PINs, and on a phone the SMS code the site just sent is offered above the keyboard. Keystrokes keep going straight into the real field.

## Principles (owner)

- One mirrored page, typed into directly. No re-created views, no separate question box, no masking layer of ours.
- A human answers human verification. No AI anywhere in the loop.
- Nothing readable by Unstuck: the new information travels inside the same end-to-end encrypted stream, and it is never a field's contents.

## Why the engine must say where fields are before the tap

iOS Safari opens the keyboard only when `focus()` runs synchronously inside the tap's own event handler. A tap travels phone → relay → the agent's machine → the browser and back; even at a few milliseconds, the answer arrives after the handler has returned, and iOS ignores the focus. (Typical round trips through the relay are 50–400 ms.) So the viewer has to know, at the moment of the tap, whether the point is inside a field and what kind.

## Approaches

- **Field map ahead of the tap, plus a focus safety net (chosen by the owner).** The engine sends the positions and kinds of the visible input fields; the viewer hit-tests each tap locally and opens the right keyboard inside the tap. After a tap, if the page reports focus in an editable element the map missed, the viewer shows a "Type here" chip.
- Focus report only: simpler, but on iPhone the keyboard can never open by itself; the person always taps a chip.
- Open the keyboard on every tap: instant, but the keyboard covers half the screen when tapping CAPTCHA images and buttons.

## Design

### Protocol (`protocol/src/viewer.ts`, engine → viewer)

Two new messages, added to `EngineToViewerSchema` and the `EngineToViewer` type:

- `{ t: 'fields', fields: Field[] }` where `Field = { x: number; y: number; w: number; h: number; kind: FieldKind }`. Coordinates are CSS pixels of the streamed page's viewport, the same space as the existing `mouse` messages. Replaces the previous map entirely; an empty list means "no fields".
- `{ t: 'focus', kind: FieldKind | null }`: the element that has focus after the person's last input is editable (`kind`) or not (`null`).
- `FieldKind = 'text' | 'numeric' | 'otp' | 'email' | 'password'`.

No change to viewer → engine messages: the engine validates `hello` strictly, so announcing a capability there would break 0.1.x engines. Compatibility needs no negotiation: older viewers ignore unknown message types (they only act on `ready`, `state` and `error`), and a new viewer with an older engine never receives a map and keeps today's behaviour.

### Engine (`core`)

- A field scanner for the target currently shown to the person (the page, or the newest popup, following the existing popup logic). It runs in the page with `Runtime.evaluate` and returns, for each visible editable element in the top document and same-origin iframes (offset by the iframe's position), its rectangle and kind:
  - `otp`: `autocomplete="one-time-code"`;
  - `numeric`: `type="number"` or `type="tel"`, or `inputmode` `numeric`/`decimal`/`tel`;
  - `email`: `type="email"` or `inputmode="email"`;
  - `password`: `type="password"`;
  - `text`: other text-like inputs, `textarea`, and `contenteditable`.
  - Skipped: `display:none`/`visibility:hidden`, disabled, read-only, zero-size, or entirely outside the viewport. Transparent inputs (`opacity: 0`) are **kept**: many code widgets stretch one invisible input over six drawn boxes, and that is the main case. Values are never read.
  - Covered fields are skipped: a field counts only if `document.elementFromPoint` at its centre returns the field or something inside it, or (for the invisible-input widgets) an element whose box is inside the field's box. A cookie banner or modal over a field therefore removes it from the map.
  - Open shadow roots are searched too (many code and PIN widgets are web components).
- When: on the first frame after a viewer joins, then at most every 500 ms while frames arrive (layout changes produce frames), right after each tap, wheel or key input (so a scroll updates the map at once instead of within 500 ms), and when the shown target changes. A message is sent when the map changed, and the current map is re-sent every 5 s so a dropped message can't leave the viewer stale for long.
- Size: coordinates rounded to whole pixels, at most 30 fields, nearest the viewport's centre first, so a map stays well under the relay's 4096-byte "big message" size.
- Focus safety net: after each `mouse` `up`, the engine checks `document.activeElement` (descending into same-origin iframes) and sends `focus` with its kind, or `null`. A focused cross-origin iframe counts as `text` (we can't look inside, and a field there is the likely case).
- A failing scan never fails the takeover: it sends no map, and the viewer keeps today's behaviour.

### Viewer

- Keeps the last `fields` map. Taps are sent to the page exactly as today. The viewer hit-tests on `pointerdown` and remembers the field; on the matching `pointerup` (no drag: the pointer moved less than 10 px), in that handler, it focuses the keyboard bridge configured for the field's kind. Focusing on release, not press, is what iOS honours most reliably and avoids opening the keyboard when a drag starts on a field:

  | kind | `inputmode` | `autocomplete` | `type` |
  |---|---|---|---|
  | `otp` | `numeric` | `one-time-code` | `text` |
  | `numeric` | `numeric` | `off` | `text` |
  | `email` | `email` | `off` | `email` |
  | `password` | `text` | `off` | `password` |
  | `text` | `text` | `off` | `text` |

  The bridge never keeps text: everything typed is forwarded as now and the bridge is cleared, so a password or code never stays in the viewer.
- A tap outside every field blurs the bridge, so the keyboard closes. `focus: null` after a tap the map thought was a field also blurs it (the page didn't take focus there).
- Keep the field in view: while the keyboard is open (`visualViewport` shrinks), the viewer shifts the mirrored page inside its frame so the tapped field sits just above the keyboard. Viewer-only; the agent's page is not scrolled.
- Code fields (`otp` and `numeric`): text arriving at the bridge in one piece (the iOS/Android SMS code suggestion, a paste, autofill) is sent as one key press per character, not one `text` message, so six-box widgets that move focus on each key fill every box. `insertReplacementText` and `insertFromPaste` input types are forwarded instead of dropped. Other kinds keep today's single `text` message.
- `focus` with a kind while the bridge isn't focused shows a "Type here" chip near the bottom bar; tapping it focuses the bridge with that kind. `focus: null` hides the chip.
- The **Keyboard** button stays, for anything else.

## Goals, non-goals, anti-goals

- Goal: on iPhone (Safari) and Android (Chrome), tapping a code, PIN, email or text field in the mirror opens the matching keyboard on the first tap, and iOS offers the SMS code for one-time-code fields.
- Non-goal: fields inside cross-origin iframes in the map (the safety net covers them), autofill of passwords, any change to how keystrokes are sent.
- Anti-goals: a field's value ever leaving the agent's page; the keyboard opening on taps that aren't on fields; breaking 0.1.x engines or older cloud-served viewers.

## Tests (builder's calls)

- Protocol: the two schemas, and that an unknown message type is ignored by the viewer's parser.
- Core: the scanner's classification and rectangles on fixture pages (each kind, hidden/disabled/read-only skipped, same-origin iframe offset, the 50-field cap), change-only sending, the focus report, and a scan error leaving the takeover running.
- Viewer: a tap inside a field focuses the bridge with the table's attributes inside the same event; outside blurs; the chip appears and works; nothing is kept in the bridge.
- e2e: two fixture pages driven by the simulated phone (Playwright iPhone 13 profile): a single OTP input, and a six-box widget (one invisible input over drawn boxes, and a variant with six `maxlength=1` inputs). After the tap the bridge has focus with `inputmode=numeric` and `autocomplete=one-time-code`; a code inserted in one piece fills all six digits in the real page; a banner over a field keeps the keyboard closed; Done resolves.

## Builder's calls made after review

Visible-but-transparent inputs count and covered ones don't; open shadow roots are searched; focus on release, not press; rescan right after each input plus a 5 s resend; at most 30 fields; code text sent as one key per character; keep the field above the keyboard in the viewer only; `focus: null` blurs.

## Left open

- Real-device check: the first build step is a throwaway spike page that the owner opens on a real iPhone (and Android, if available) to confirm that focusing on release opens the number pad and offers the SMS code. If iOS refuses, the design changes before the rest is built. The full feature gets the same check before release.
- Release: 0.1.3 for the engine and SDKs; Unstuck Cloud re-vendors the viewer so the hosted relay serves the new viewer.
