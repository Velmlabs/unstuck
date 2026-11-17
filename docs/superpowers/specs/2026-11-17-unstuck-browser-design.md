# Unstuck Browser: a wrapper for your agent's headless browser that asks a person when it's stuck

**Date:** 2026-11-17 · **Status:** draft for the owner's review · **Repo:** velmlabs/unstuck (open source), shipped in
the existing packages.

## Intent

Everyday AI agents fetch pages, get blocked (curl refused, then a real browser hits "verify you're human", a CAPTCHA, a
login or 2FA), and give up. Unstuck Browser makes that a non-event. It wraps the headless browser the agent already uses,
and when a page turns into a human check, it brings in a person through Unstuck's takeover (link, Telegram, phone), then
lets the agent carry on in the same session. It remembers solved sites so later runs go straight through. The owner sees
this as **the product**: Unstuck's takeover becomes the engine behind it.

## Goals

- **One line to protect an agent.** `unstuck.wrap(page)` (TS and Python) for Playwright and Puppeteer pages; a hook and an
  `ask_human` action for browser-use; Obscura through the Chrome DevTools Protocol (CDP).
- **Zero-setup for chat agents.** The Unstuck MCP server can start its own headless browser (Chrome, or Obscura) and
  offers browsing tools with the rescue built in.
- **Automatic rescue.** After navigations and actions, Unstuck checks the page for known human checks. When one appears,
  it runs a takeover and returns only when the person is done (or the takeover ends). The agent's call just takes
  longer.
- **Session memory.** Solved and logged-in sites are remembered in a local profile, and reused on later runs until the
  cookies expire or the user forgets the site.
- **Hand-off to other tools.** On request, return the session (cookies plus the User-Agent that earned them) so the
  agent can continue with curl or its own scripts.
- **Same privacy and safety as today.** End-to-end encrypted takeovers, the page lock, a person always solves, passwords
  are typed by the person.

## Non-goals (v1)

- No hosted browser of our own. The wrapped browser runs wherever the agent's does (laptop, server, Worker, Browserbase).
  Hosted browsers stay parked (Cloudflare terms / VPS route).
- No automatic solving, no CAPTCHA-solving services, no stealth or fingerprint evasion.
- No `approve(action)`, file uploads or downloads, or multi-tab orchestration in v1. These are later steps.
- No zero-code CDP proxy in v1. That's approach C, kept for a later "zero-code mode".
- No Selenium or Stagehand adapters in v1. Stagehand works today through its Playwright page.

## Anti-goals

- **Never a CAPTCHA farm.** A rate limit on person-checks is built in, on by default, and documented.
- **Never a bypass tool.** The docs and tool descriptions say a person solves, and site terms still apply.
- **Secrets stay out of the model.** Never put cookies or passwords into the LLM's context unless the agent explicitly
  asks for the session, and never put passwords there at all.
- **Breaking today's API is out.** The existing SDK APIs, the four MCP takeover tools and the viewer keep working unchanged.

## Approaches considered

- **A. Built into the existing packages (chosen by the owner).** Add a "guard" to core: detection, auto-rescue and the
  session store. Put thin adapters in the SDKs, and browsing tools in the existing MCP server, behind a flag.
  - One install; it reuses the proven takeover. Branded "Unstuck Browser" in the docs.
  - Cost: the MCP server grows. A startup flag keeps it takeover-only for those who want that.
- **B. A separate `@velmlabs/unstuck-browser` package and MCP server.** A clearer product split, but two installs, two
  release pipelines and docs that have to explain the choice.
- **C. A CDP proxy in front of any browser.** It works with anything that speaks CDP with only an address change. It's
  the hardest to get right (multiplexed sessions, tabs, frames, pausing commands), and agents that launch their own
  browser would have to switch to connecting. Kept for v2.

## Decisions (owner's, from the conversation)

- **v1 targets:** Playwright (TS and Python), Puppeteer, browser-use, Obscura and MCP.
- **The agent decides how to continue:** reuse the returned session (cookies), or keep browsing through Unstuck. Both
  are supported.
- **Full browsing in the MCP server:** not only `fetch_page`, but `open`, `click`, `type`, `select`, `scroll`,
  `wait_for`, `screenshot` and a page snapshot.
- **Local first:** it runs wherever the agent's browser is. Unstuck Cloud adds phone alerts and links that work on any
  device, as today.

## Calls I made (check these)

- **Cookies are returned only when asked** (`include_session: true`). By default the agent gets text.
- **Rescue scope by default: challenges only** (Cloudflare interstitials and Turnstile, reCAPTCHA, hCaptcha, and generic
  "verify you are human" pages). Login walls and 2FA are rescued when the wrap or tool is told to
  (`rescue: ['challenge', 'login', '2fa']`), or when the agent calls `ask_human`. Login detection is heuristic, and a
  false positive that pings a person is worse than a missed one.
- **Rate limit:** at most 10 person-checks per hour per profile by default, configurable. Over the limit, rescue doesn't
  start: the call returns or throws `rescue_limited`, so the agent can stop.
- **Session store:** under `~/.unstuck/profiles/<profile>/` (`default` unless set). It holds a `sites.json` of cookies per
  registrable domain, with the User-Agent and when each site was solved. The file is mode 0600. Cookies past their own
  expiry are dropped on load. `forget_site(domain)` and `forget_all()` clear entries.
  - Python and TS share the format.
  - In a Worker there's no filesystem: the store is pluggable (an interface with a file implementation, an in-memory one,
    and room for KV or Durable Object storage). The Workers docs show one.
- **Snapshot format:** a compact numbered list of the interactive and visible text elements from the accessibility tree
  (role, name, value, `ref`). `click`, `type` and `select` take a `ref`. This mirrors what agents already handle well
  from Playwright MCP.
- **Text extraction:** readable markdown via a readability pass. It's kept small: no new heavy dependency in core; core
  stays runtime-agnostic, and Node-only helpers live in the SDK or engine.

## More calls from the builder review (check these)

- **A rescue inside an MCP browsing tool:**
  - **Short rescue:** the tool blocks for up to 40 seconds. If the person finishes in that time, it returns its normal
    result with `{ rescued: true, waited_s }`.
  - **Longer rescue:** the tool returns
    `{ status: 'human_needed', takeover_id, link, code?, expires_in_s }`, like `start_human_takeover`. The agent then
    calls a new tool, `resume_after_human { takeover_id, max_wait_s? }`. It waits in rounds, the same way as
    `wait_for_human_takeover`. Once the person is done, it re-runs detection and returns what the original tool would
    have returned: page content for `fetch_page`, a snapshot for the others. It never repeats the action (no
    re-navigation, no second click).
  - **The existing four takeover tools stay unchanged.**
  - **While a takeover holds the page:** other browsing calls get `{ error: 'human_takeover_active', takeover_id }`.
    The browsing tools and the takeover share the server's single browser connection.
- **Wrapped Playwright and Puppeteer methods when a rescue fails:**
  - They throw an `UnstuckRescueError` (TS) or `UnstuckRescueError` exception (Python) with `status` and `detail`:
    `still_blocked`, `timed_out`, `cancelled`, `rescue_limited` or `alert_failed`.
  - They never throw when no check was detected. `wrap()` is opt-in, so code that doesn't wrap is unaffected.
  - Option `onRescueFail: 'throw' | 'return'` (default `'throw'`), because carrying on against a challenge page is
    worse than stopping.
  - **On success:** the call returns normally. `page.unstuck.lastRescue` and an optional `onRescue(event)` callback say
    a rescue happened.
- **Existing MCP users get nothing new by default.** The browsing tools appear only with `--browser` (Unstuck starts
  its own browser) or `--tools browser` (wrap the browser at `UNSTUCK_CDP_URL`).
  - **Browser launch:** lazy, on the first browsing call.
  - **Which Chrome:** a new launcher finds a system Chrome or Chromium (the usual install paths, or `CHROME_PATH`). If
    none is found, it fails with a clear hint (`npx playwright install chromium`, or set `CHROME_PATH`). No bundled
    browser in v1.
- **Session memory:**
  - **Defaults:** off by default in library wraps (`remember: true` turns it on). On by default in MCP `--browser`
    mode, which has its own dedicated profile and is the product experience.
  - **What's saved:** after a successful rescue, the cookies of the rescued site's registrable domain, plus the
    `allowed_sites` domains used during that takeover. A site the agent logs into on its own is saved only if it calls
    `remember_site(domain)` / `page.unstuck.rememberSite(domain)`.
  - **Remembered cookies never overwrite cookies the context already has** (only missing ones are set).
- **Python:** the guard (detection rules, rescue, store, rate limiter) runs in the engine, reached through new
  JSON-lines RPC methods. That means one implementation, and a protocol minor bump with an engine capability check, so
  an older engine refuses clearly. v1 supports async Playwright in Python; sync Playwright is a later step.
- **The curl hand-off is best-effort and documented that way.** Login sessions carry over well. Challenge clearances
  such as `cf_clearance` are often tied to the IP, the TLS fingerprint and the User-Agent, so curl may be challenged
  again. The docs recommend `fetch_page` through the browser as the reliable path.

## How it works

### The guard (core, runtime-agnostic)

- **Detection:** `detectHumanCheck(cdp, opts) → { kind: 'challenge' | 'login' | '2fa', vendor?, evidence } | null`.
  - **Signals checked over CDP:**
    - the main frame's URL and title (for example "Just a moment...");
    - known challenge iframes and scripts (`challenges.cloudflare.com`, `google.com/recaptcha`, `hcaptcha.com`);
    - challenge DOM markers;
    - HTTP status with challenge headers (`cf-mitigated: challenge`, 403 or 503 on the main document);
    - for login (opt-in only): a password field plus a URL or path that looks like a login page after a redirect from
      the requested URL.
  - **Rules:** the signals live in a data table, versioned and tested against saved fixture pages of each vendor's
    challenge.
- **Rescue:** `rescue(cdp, check, opts) → TakeoverResult`. It runs the existing takeover with `reason` built from the
  check, for example "Cloudflare asks to verify you're human on example.com", with the page lock and alerts as configured.
  - **Done:** it waits for the page to settle and re-runs detection. If the check is still there, it returns
    `still_blocked`, not a second takeover.
- **Session store:** `SessionStore` interface (`load(domain)`, `save(domain, cookies, userAgent)`, `forget`), with
  cookie get/set through CDP `Storage.getCookies` / `Network.setCookies`, so it works on any CDP browser.
- **Rate limiter:** per profile, persisted in the same store.

### Adapters

- **Playwright (TS and Python):** `wrap(page, opts) → page`. Hooks `page.goto`, `reload`, `click`, `fill`, `press`,
  `waitForNavigation` and `waitForURL` (and the Python equivalents). After each, it runs detection on the main frame, and
  rescue if needed.
  - It returns the same page object, augmented, so existing code keeps working. It also exposes `page.unstuck.askHuman`,
    `getSession` and `forgetSite`.
  - On wrap, it loads remembered cookies into the context for the domains about to be visited (lazily, on navigation).
- **Puppeteer (TS):** the same API over Puppeteer's `Page`.
- **browser-use (Python):** an `UnstuckTools` (or the library's current extension point; check its current API) that
  adds an `ask_human` action and a post-step hook that runs detection and rescue. It connects through its Playwright
  page or CDP URL.
- **Obscura:** through CDP (`connectOverCDP` / `puppeteer.connect`), so the Playwright and Puppeteer wrappers apply.
  Whether the takeover itself works on Obscura is decided by the spike (below).

### MCP server (engine)

- **Startup:**
  - **Browser:** `--browser` (start its own headless Chrome, or `--browser=obscura` with `--obscura-path`), or
    `UNSTUCK_CDP_URL` to wrap an existing browser.
  - **Profile:** `--profile <name>`.
  - **Takeover only:** `--tools takeover` keeps today's four tools only.
- **New tools:**
  - `fetch_page { url, format: 'markdown' | 'text' | 'html', include_session? }` returns
    `{ final_url, status, title, content, session? }`;
  - `open { url }`, `snapshot`, `click { ref }`, `type { ref, text, submit? }`, `select { ref, value }`,
    `scroll { direction }`, `wait_for { text | ref, timeout_s }`, `screenshot`;
  - `ask_human { reason }` (the two-step variants of 0.2.9 still apply);
  - `get_session { domain }`, `forget_site { domain }`.
  - Every navigating or acting tool returns the post-action snapshot (or a short summary) and runs the guard. A rescue
    inside a tool call is reported in the result: `{ rescued: true, waited_s }`.
- **Long rescues and tool timeouts:** if a rescue starts inside a browsing tool, the tool returns
  `{ status: 'human_needed', takeover_id, link, ... }` as `start_human_takeover` does. The agent then calls
  `wait_for_human_takeover`, so no call outlives the client's time limit.

### Obscura: what we already know

The spike of 2026-11-12 (`docs/spikes/obscura.md`) and the engine's `doctor` both rate Obscura **Limited**:
- **What works:** screencast, screenshots, mouse, keyboard and `insertText`.
- **What doesn't:** Obscura doesn't paint cross-origin iframes. Every reCAPTCHA, hCaptcha and Turnstile widget lives in
  one, so the person would see a blank box.
- **Popups:** not reported.

So challenges can't be solved inside Obscura today. Login, 2FA and other first-party pages can. Re-run the probe on
each new Obscura release.

**v1 Obscura scope: OPEN, owner's decision pending.** The options:
- (a) Detect challenges and fail clearly (`browser_cannot_render_captcha`); rescue only login, 2FA and first-party
  pages.
- (b) Also hand off to a full Chrome: copy the cookies over, the person solves there, copy them back. This needs Chrome
  on the machine. It may not stick, because clearance cookies are tied to the User-Agent and IP, and to fingerprints.

## Testing

- **Fixture pages** for each challenge vendor (saved HTML and iframes, served locally) run the detection tests for
  each rule, plus negative fixtures: normal pages that mention "captcha", and login pages when login rescue is off.
- **End-to-end:** each adapter wraps a page, navigates to a local fixture challenge, a person (the test harness) taps
  Done, and the call returns past the check. Session memory: a second run skips the check. The rate limit kicks in at N.
- **MCP:** the tool schemas, a `fetch_page` round trip, rescue via `human_needed`, `--tools takeover`, and own-browser
  startup and shutdown.
- **Coverage stays above 90%** in every package; core stays free of Node built-ins.

## Docs and branding

- **A new "Unstuck Browser" section in the docs:** what it is, `wrap(page)` for each target, MCP with its own browser,
  session memory and forgetting, the rate limit, and "a person solves; site terms still apply".
- **The landing page** gets one line under how it works.
- **README:** a short section with the one-line wrap.

## Left to the builder

- The readability and markdown approach (no heavy dependency in core).
- Exact hook points per library version.
- The snapshot's exact text format within the spirit above.
- How Chrome is found and launched for `--browser` (reuse the engine's existing browser discovery).
