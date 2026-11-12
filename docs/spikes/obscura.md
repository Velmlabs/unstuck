# Spike: Obscura compatibility

- **Date:** 2026-11-12 · **Plan 1, Task 1** · Probe: `spikes/obscura/probe.mjs` (throwaway)
- **Obscura version:** 0.2.6 (`obscura-x86_64-linux.tar.gz`, latest release), `obscura serve --port 9222`
- **Baseline:** Playwright's bundled Chromium, same probe, same machine
- **Environment note:** this sandbox only allows HTTPS through a proxy, and Obscura has no proxy bypass list, so fixtures were injected into `https://example.com/` with `setContent` instead of being served from 127.0.0.1.

## Results

| Capability (spec §4.4) | Obscura 0.2.6 | Chromium |
|---|---|---|
| Connect via `connectOverCDP` | ✅ | ✅ (launched) |
| `Runtime.evaluate` | ✅ | ✅ |
| `Page.startScreencast` | ✅ 3 frames in 1.5 s, correct `deviceWidth/Height` 1280×720 | ✅ 4 frames |
| `Page.captureScreenshot` | ✅ | ✅ |
| `Input.dispatchMouseEvent` click | ✅ | ✅ |
| `Input.dispatchKeyEvent` | ✅ | ✅ |
| `Input.insertText` (`héllo 日本`) | ✅ | ✅ |
| Popup tracking (`window.open` → new page event) | ❌ no page event within 8 s | ✅ 0.35 s |
| **Cross-origin iframe content in screenshots/screencast** | ❌ **not painted** | ✅ |
| reCAPTCHA v2 demo | ❌ iframe exists in the DOM, widget area is blank | ✅ "I'm not a robot" checkbox drawn |
| hCaptcha demo | ❌ widget area blank | ✅ |
| Turnstile (always-pass test key `1x00000000000000000000AA`) | ❌ whole page blank | ✅ "Success!" widget drawn |

The `Target.setAutoAttach` probe was inconclusive for both browsers: neither reported iframe targets over a page-level session, and the IANA page used as the child refused framing in Chromium. The CAPTCHA screenshots answer the real question anyway: Obscura doesn't paint cross-origin iframe content.

## Verdict

**Obscura can't be used for CAPTCHA takeovers today.** Every major CAPTCHA widget lives in a cross-origin iframe, and Obscura's renderer leaves those areas blank. A human looking through Unstuck would see an empty box with nothing to click. Its core CDP surface (screencast, screenshots, input, `insertText`) works well, so first-party pages are fine.

## Recommendation for the spec

- **Change Obscura from Tier 2 to "Limited":** supported for takeovers on **first-party pages** (login forms, 2FA/OTP inputs, confirmation dialogs, confusing UIs). **Not supported for CAPTCHA takeovers** until it paints cross-origin iframes.
- **Capability check (spec §4.4):** add a **"cross-origin iframe paint"** probe. Load a known same-colour cross-origin iframe, capture a screenshot, and check the pixel. Popup tracking is missing on Obscura, so the existing popup warning applies.
- **Watch mode (Plan 2):** when attached to a browser that fails the iframe-paint check and a `captcha.*` rule matches, return `failed` with detail `browser_cannot_render_captcha` and a hint to use Chromium, rather than opening a takeover the human can't complete.
- **Docs:** recommend agents that run Obscura for scale fall back to Chromium for the pages where a CAPTCHA appears.
- Re-run this probe on each new Obscura release (it moves quickly); CI keeps it in the Tier 2 compatibility suite.
