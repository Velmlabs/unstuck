# Unstuck over MCP

The Unstuck engine is an MCP server with one tool, `request_human_takeover`. When your agent calls it, Unstuck takes over the Chrome tab the agent is using, sends a person a link (printed, logged to the MCP client and, with `--open`, opened in this computer's browser) and returns once they tap **Done** or **Can't solve**.

## 1. Start Chrome with a debugging port

Unstuck attaches to a Chrome your agent already drives. Start it with port 9222:

- **macOS:** `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.unstuck-chrome"`
- **Linux:** `google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.unstuck-chrome"`
- **Windows:** `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.unstuck-chrome"`

A separate `--user-data-dir` keeps this browser apart from your everyday profile.

## 2. Add the server to your client

- **Claude Code:** run `claude-code.sh`.
- **Claude Desktop:** merge `claude-desktop.json` into Settings → Developer → Edit Config.
- **Cursor:** merge `cursor.json` into `~/.cursor/mcp.json`.
- **With the Playwright MCP server**, so the agent browses and Unstuck takes over the same browser: use `playwright-mcp.json`.

## 3. Ask for help

Tell your agent, for example: *"If you hit a CAPTCHA or a login, call request_human_takeover with the reason."* The tool blocks until the person is done and returns JSON like `{"status":"resolved","duration_s":42}`.

To send the link through Unstuck Cloud (so it opens on any phone, from anywhere), add `"UNSTUCK_API_KEY": "uk_live_…"` to the server's `env`.
