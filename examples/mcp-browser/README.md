# Unstuck Browser over MCP

`--mcp --browser` runs the Unstuck MCP server with a headless Chrome of its own. Your agent reads and drives pages
with it; when a page shows a CAPTCHA or a "verify you are human" check, a person solves it through a link and the
agent carries on. A person solves every check; the site's terms still apply.

| File | Client |
|---|---|
| [`claude-code.sh`](claude-code.sh) | Claude Code |
| [`claude-desktop.json`](claude-desktop.json) | Claude Desktop |
| [`codex.toml`](codex.toml) | Codex CLI, the ChatGPT desktop app, the Codex IDE extension |

The browser starts on the first browsing call, not when the server starts. It needs Chrome or Chromium on the
machine (or `npx playwright install chromium`; `CHROME_PATH` picks a binary). `--browser=obscura` uses
Obscura instead, with limited support: it can't show CAPTCHA widgets (they live in cross-origin
iframes, which Obscura doesn't paint), so a challenge there ends at once with `browser_cannot_render_captcha`;
logins, 2FA and other first-party pages work. `--tools browser` adds the same tools on the Chrome
at `UNSTUCK_CDP_URL` instead of starting one.

## Tools

- `fetch_page`: open a URL and return its readable content (markdown, text or html), the final URL and the HTTP
  status. `include_session: true` adds the site's cookies and user agent, for curl or an HTTP client (best effort:
  some sites bind a clearance to the browser, so `fetch_page` through the browser is the reliable path).
- `open`, `snapshot`, `click`, `type`, `select`, `scroll`, `wait_for`, `screenshot`: drive the page by the refs
  (`e1`, `e2`…) in its snapshot. Password fields are never shown and never typed: the person does that.
- `ask_human`: bring a person in for something only they can do (a login, a 2FA code).
- `resume_after_human`: when a check takes the person longer than about 40 s, a browsing tool returns
  `status: "human_needed"` with the link to show them. Call `resume_after_human` with its `takeover_id` until it
  returns the original call's result. Other browsing calls meanwhile return `human_takeover_active`.
- `get_session`, `remember_site`, `forget_site`: a site's cookies, saved to or removed from the profile.

The takeover tools (`request_human_takeover`, `start_human_takeover`, `wait_for_human_takeover`,
`cancel_human_takeover`) work on the same tab when you don't pass `cdp_url`.

## Options

- `--profile <name>` (default `mcp`): remembered sites live in `~/.unstuck/profiles/<name>/sites.json`, readable only
  by you. `--no-remember` keeps nothing.
- `--max-rescues-per-hour <n>` (default 10): at most this many person-checks an hour on the profile; past it a check
  returns `rescue_limited`.
- `UNSTUCK_IN_TOOL_WAIT_S` (default 40): how long a browsing call waits for the person before it returns the link.
  Keep it under your client's tool timeout.
- `UNSTUCK_API_KEY`: send the link through Unstuck Cloud, so it opens on any phone (and alerts your paired phones).
