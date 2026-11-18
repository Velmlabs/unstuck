# Unstuck with agent-browser (or any shell-driven browser)

[agent-browser](https://github.com/vercel-labs/agent-browser) drives Chrome one shell command at a time. The `unstuck`
commands fit the same way: each prints one JSON line and exits with a code the agent branches on. When a page shows a
CAPTCHA, a login wall or a 2FA prompt, a person solves it through a link and the agent carries on in the same tab.
A person solves every check; the site's terms still apply.

```sh
npm install -g agent-browser @velmlabs/unstuck-engine   # gives `agent-browser` and `unstuck`
```

## The loop, as a shell session

```sh
$ agent-browser open https://shop.example/checkout
$ CDP="$(agent-browser get cdp-url)"
$ agent-browser tab list --json        # note the targetId of the tab you're using
$ TAB=8081AB0A0E24433A430C71F27681F878

$ unstuck check --cdp "$CDP" --tab "$TAB"; echo "exit $?"
{"status":"check_found","check":{"kind":"challenge","vendor":"cloudflare","site":"shop.example"}}
exit 20

$ unstuck rescue --cdp "$CDP" --tab "$TAB"; echo "exit $?"
{"status":"human_needed","id":"Q2x1ZS1yZXF1ZXN0LWlk","link":"https://…","expires_in_s":600,"reason":"…"}
exit 10
# The agent shows the person the link (only them). They open it, tap Start, solve it, tap Done.

$ unstuck wait Q2x1ZS1yZXF1ZXN0LWlk; echo "exit $?"
{"status":"waiting","id":"Q2x1ZS1yZXF1ZXN0LWlk","joined":true,"expires_in_s":541}
exit 11
$ unstuck wait Q2x1ZS1yZXF1ZXN0LWlk; echo "exit $?"
{"status":"resolved","check":{"kind":"challenge","vendor":"cloudflare","site":"shop.example"},"waited_s":74}
exit 0

$ agent-browser snapshot               # carry on in the same tab
```

With a single tab open, `--tab` can be left out. `UNSTUCK_CDP_URL` can replace `--cdp`.

## Exit codes

| Exit | Status | Next |
|---|---|---|
| `0` | `clear`, `resolved`, `answered` | Carry on |
| `10` | `human_needed` | Show the link, then `unstuck wait <id>` |
| `11` | `waiting` | `unstuck wait <id>` again |
| `20` | `check_found` | `unstuck rescue` |
| `30` | `failed`, `cancelled`, `timed_out`, `still_blocked`, `rescue_limited` | Tell the user; don't loop |
| `2` | usage or setup problem (`several_tabs`, `no_cdp`, `tab_not_found`…) | Fix the command |

## More

- `unstuck takeover --reason "Log in with your account"` hands the tab over for anything only the person can do.
- `unstuck ask "Which flight?" --choice "7:05" --choice "9:40"` asks a question without a page.
- `unstuck cancel <id>` ends a request. Killing `wait` doesn't: the request runs in the background until it ends.
- Phone alerts and links that work on any phone: set `UNSTUCK_API_KEY` (Unstuck Cloud). Without it the link works on
  this computer and your local network.

Give your agent the skill in [`plugins/unstuck`](../../plugins/unstuck): it tells the agent to run `unstuck check`
after each navigation. Guide: https://unstuck.sh/docs/agent-browser/
