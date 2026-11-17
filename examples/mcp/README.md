# Unstuck over MCP

The Unstuck engine is an MCP server with one tool, `request_human_takeover`. When your agent calls it, Unstuck takes over the Chrome tab the agent is using, sends a person a link (printed, logged to the MCP client and, with `--open`, opened in this computer's browser) and returns once they tap **Done** or **Can't solve**.

## 1. Start Chrome with a debugging port

Unstuck attaches to a Chrome your agent already drives. Start it with port 9222:

- **macOS:** `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.unstuck-chrome"`
- **Linux:** `google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.unstuck-chrome"`
- **Windows:** `"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.unstuck-chrome"`

A separate `--user-data-dir` keeps this browser apart from your everyday profile.

## 2. Add the servers to your client

Each file adds Unstuck and, where the client needs one, the Playwright MCP server pointed at the same Chrome, so the agent browses and Unstuck takes over the same tab. Setup steps for each client, checked on 2026-11-17: [unstuck.sh/docs/agents](https://unstuck.sh/docs/agents/).

| Client | File | Where it goes |
|---|---|---|
| Claude Code | `claude-code.sh` | run it |
| Claude Desktop | `claude-desktop.json`, or `playwright-mcp.json` with a browser | Settings → Developer → Edit Config |
| Cursor | `cursor.json`, or `playwright-mcp.json` with a browser | `~/.cursor/mcp.json` |
| Cline, Devin Desktop (Windsurf) | `playwright-mcp.json` | Cline's MCP settings; `~/.config/devin/mcp_config.json` |
| Codex CLI, ChatGPT desktop app | `codex.toml` | `~/.codex/config.toml` |
| VS Code (GitHub Copilot), Copilot CLI | `copilot-mcp-config.json` | `~/.copilot/mcp-config.json` |
| Gemini CLI | `gemini-settings.json` | `~/.gemini/settings.json` |
| Antigravity CLI | `antigravity-mcp-config.json` | `~/.gemini/config/mcp_config.json` |
| OpenCode | `opencode.json` | `~/.config/opencode/opencode.json` |
| Goose | `goose.yaml` | `~/.config/goose/config.yaml` |
| pi | `pi-mcp.json` | `~/.pi/agent/mcp.json` |

Merge the servers into any config you already have; don't replace the file.

## 3. Ask for help

Tell your agent, for example: *"If you hit a CAPTCHA or a login, call request_human_takeover with the reason."* The tool blocks until the person is done and returns JSON like `{"status":"resolved","duration_s":42}`.

To send the link through Unstuck Cloud (so it opens on any phone, from anywhere), add `"UNSTUCK_API_KEY": "uk_live_…"` to the server's `env`.

## Show the link in the chat (two-step flow)

Since 0.2.9 the server also has `start_human_takeover`, which returns the link at once so the agent can show it to
you, and `wait_for_human_takeover`, which waits in short rounds (45 s by default) for Done or Can't solve. That keeps
each tool call under the client's timeout. Ask your agent: *"If you hit a CAPTCHA or a login, call
start_human_takeover and show me the link."* The link opens on any device only with Unstuck Cloud (`UNSTUCK_API_KEY`)
or your own relay; otherwise it is a `127.0.0.1` link for this computer.
