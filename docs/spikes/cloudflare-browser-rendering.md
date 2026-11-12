# Spike: Cloudflare Browser Rendering

- **Date:** 2026-11-12 · **Plan 1, Task 2** (run after the owner authorised the Cloudflare account) · Worker: `spikes/cloudflare/` (throwaway; deployed once to `unstuck-spike-browser.<account>.workers.dev`, measured, then deleted)
- **Stack:** `@cloudflare/puppeteer` with the `[browser]` binding, `page.createCDPSession()`, viewport 1280×720

## Results

| Capability Unstuck needs | Result |
|---|---|
| `Runtime.evaluate` | ✅ |
| `Page.startScreencast` | ✅ 21 frames in ~4 s (≈5 fps while the test repainted every 150 ms); `metadata.deviceWidth/Height` 1280×720 |
| `Page.captureScreenshot` | ✅ |
| `Input.dispatchMouseEvent` (click) | ✅ |
| `Input.insertText` (`héllo 日本`) | ✅ |
| `Input.dispatchKeyEvent` | ✅ |
| reCAPTCHA v2 demo renders (cross-origin iframe) | ✅ "I'm not a robot" widget drawn |
| hCaptcha demo renders | ✅ |
| Turnstile (always-pass test key) renders | ✅ "Success!" widget drawn |
| Popups (`window.open`) reported | ✅ `targetcreated` fired |

The whole run (browser launch, 3 CAPTCHA pages with 5 s waits each) took ~30 s.

## Verdict

**Cloudflare Browser Rendering is a Tier 1-quality host for Unstuck.** It's real Chromium: screencast, input, paste, cross-origin iframes and popups all work, so no fallback is needed (spec §14 risk 1 is resolved; the screenshot-polling fallback stays only for other browsers).

## What this enables

- **Cloudflare-native agents:** an agent running in a Worker (Agents SDK, Browser Rendering) can call Unstuck in-process (spec §4.3) and use the Cloudflare relay; the human sees the hosted browser live.
- **A public demo:** a visitor clicks "Try it", a Worker opens a fixture CAPTCHA page in Browser Rendering, starts a takeover, and the visitor solves it on their phone. No local install, no agent of their own.
- Browser Rendering has per-account limits on concurrent browsers and browser time, so a public demo needs rate limiting and short timeouts.
