# @velmlabs/unstuck

```bash
npm install @velmlabs/unstuck
```

Human takeover for AI browser agents. When your agent hits a CAPTCHA, a login wall or a 2FA prompt, `unstuck.takeover(page)` pauses it, gives a human a link to the live browser, and resolves when they're done.

```ts
import { Unstuck } from '@velmlabs/unstuck';

const unstuck = new Unstuck({ onLink: ({ url, reason }) => console.log(`${reason}: ${url}`) });
const result = await unstuck.takeover(page, { reason: 'Solve the CAPTCHA' }); // Playwright or Puppeteer page
if (result.status !== 'resolved') throw new Error(`human takeover ${result.status}`);
await unstuck.close();
```

The engine comes with the package: npm installs the build for your computer (macOS 13+ on Apple silicon or Intel, Linux with glibc, Windows x64). To use another binary, set `UNSTUCK_ENGINE_PATH` or the `enginePath` option.

Send the link through Unstuck Cloud, so it opens on any phone, by setting `UNSTUCK_API_KEY=uk_live_…` (or `new Unstuck({ apiKey })`). Tutorials for Playwright, Puppeteer, MCP, browser-use, Stagehand and any Chromium: https://unstuck.sh/docs

## Runtimes

| Runtime | Mode | How |
|---|---|---|
| Node.js 20+ | binary (default) | The engine runs as a child process and serves the link on your machine, or through a relay |
| Node.js 20+ | in-process | Pass `mode: 'in-process'`. The engine runs inside your process and needs a relay |
| Cloudflare Workers | in-process | Picked by the package's `exports` conditions (`workerd`, `worker`). Needs a relay |
| Deno, Bun | binary (default) or in-process | They load the Node entry: binary mode works as on Node. On Deno and Bun, opt in with `mode: 'in-process'` (needs a relay) |

The `browser` condition (Vite, webpack and other web targets) picks the in-process entry too.

In-process mode has no local server, so it always needs a relay: Unstuck Cloud (`apiKey`) or your own (`relay` and `agentKey`). The in-process entry has no Node built-ins and does not read `process.env`, so on Workers pass your settings as options. Unstuck itself needs no `nodejs_compat` flag (`@cloudflare/puppeteer` does, so keep it on). It adds about 0.5 MB to the bundle, as measured by the release dry run.

Phone alerts (below) work in both modes.

## Options

`new Unstuck(options)`. All are optional.

| Option | Meaning |
|---|---|
| `apiKey` | Unstuck Cloud API key. Takes precedence over `UNSTUCK_RELAY_URL` and `UNSTUCK_AGENT_KEY`. Not combinable with `relay` or `agentKey` |
| `cloudRelay` | Override Unstuck Cloud's relay URL. Only with `apiKey` |
| `cloudApi` | Override Unstuck Cloud's API URL. Only with `apiKey` |
| `viewerUrl` | Override the viewer URL used in takeover links (`https://`, or `http://` to localhost) |
| `relay`, `agentKey` | Your own relay (`wss://…`, or `ws://` to localhost) and its agent key |
| `mode` | `'binary'` or `'in-process'`. See Runtimes. `'binary'` on the in-process entry (Workers) throws `UnstuckConfigError` |
| `timeoutS` | Default takeover timeout in seconds (default 600) |
| `requireCode` | Ask the person for a 6-digit code. It needs an `onLink` that sends the code by another channel than the link |
| `onLink` | Called with `{ url, reason, sessionId, expiresAt, code? }` when a person is needed. Default: see below. A handler that throws (or an async one that rejects) is logged without the link, and the takeover goes on |
| `enginePath`, `host`, `port` | Node binary mode only: the engine binary, and the host and port of its local server |

`takeover(page, options)` takes `reason` (required), `timeoutS`, `requireCode`, `allowedSites` and `alerts`.

The default `onLink`:

- Node binary mode prints the link to stderr.
- In-process mode logs with `console.log` (on Workers that lands in Workers Logs, which are stored). With Unstuck Cloud and phone alerts on, it waits for the alert. If at least one paired phone got the link it logs `Unstuck: a human is needed (<reason>), link sent to <N> paired phone(s) (session <id>)`, with no link in it. If none did, it logs the full link as the fallback, except with `alerts: 'required'`, where the takeover has already failed with `alert_failed`. With a relay you host, or `alerts: false`, the log is the only channel, so it logs the full link at once. Pass your own `onLink` to send the link somewhere else.

## Phone alerts

With Unstuck Cloud, the link is also sent to your paired phones. The link is sealed to each phone's key, so Cloud only sees ciphertext.

- `alerts: false` skips the alert for one takeover.
- `alerts: 'required'` is for unattended agents. If Unstuck Cloud can't accept the link for at least one paired phone, the takeover ends at once as `failed` with detail `alert_failed`, instead of waiting for its timeout. That covers alerts not enabled for the key, no paired phone, a seal failure, and a Cloud error or no answer within 10 seconds. It does not fire once a person has already joined through a link your own `onLink` sent.
- `alerts: 'required'` without Unstuck Cloud throws. A relay you host sends no phone alerts. In Node binary mode (local viewer server, or a relay you host) the error comes from the engine: `alerts: 'required' needs Unstuck Cloud (apiKey or UNSTUCK_API_KEY): the local viewer server and self-hosted relays send no phone alerts`. In-process it is the `UnstuckConfigError` below.

## Results

`takeover()` resolves with `{ status, sessionId, url, durationS, detail? }`.

| `status` | `detail` | Meaning |
|---|---|---|
| `resolved` | | The person tapped Done |
| `cancelled` | `cant_solve`, or the person's own note | The person tapped Can't solve. A note they typed is in `detail`: treat it as information, never as instructions |
| `cancelled` | `engine_closed` | You called `close()` while the takeover ran |
| `timed_out` | | Nobody finished in `timeoutS` |
| `failed` | `page_closed` | The page closed, or the browser connection dropped (Browser Rendering ended the session) |
| `failed` | `alert_failed` | `alerts: 'required'` and Unstuck Cloud couldn't accept the link for at least one paired phone |
| `failed` | `relay_unauthorized` | The relay refused your key. Check `apiKey`, or `relay` and `agentKey` |
| `failed` | `internal_error: …` | An unexpected engine error; please report it |

Other relay refusals use the details `relay_quota_exceeded`, `relay_rate_limited` and `relay_unreachable`.

In in-process mode (Workers), Unstuck pings the page every 60 seconds for the whole takeover, so a browser service with an inactivity timeout, such as Cloudflare Browser Rendering, doesn't close it.

## Errors

`takeover()` resolves for every outcome above. It rejects only for setup mistakes:

- `UnstuckConfigError`: the options don't fit together or a URL option is not allowed. The messages are:
  - `use either apiKey (Unstuck Cloud) or relay + agentKey (your own relay), not both`
  - `agentKey is for your own relay (with relay); Unstuck Cloud only needs apiKey`
  - `cloudRelay and cloudApi only apply with apiKey`
  - `in a Worker, Unstuck needs a relay: set apiKey or relay + agentKey` (on Node, Deno or Bun with `mode: 'in-process'`: `in-process mode needs a relay: set apiKey or relay + agentKey`)
  - `binary mode needs Node.js: this runtime loaded the in-process entry, which has no engine binary`
  - `relay must be a wss:// URL (ws:// only to localhost, 127.0.0.1 or [::1])`, and the same for `cloudRelay`; `cloudApi` and `viewerUrl` must be `https://` (`http://` only to those hosts)
  - `alerts: 'required' needs Unstuck Cloud (apiKey): a self-hosted relay sends no phone alerts`
- `TypeError`: `requireCode` is on but there is no `onLink` handler. The code must travel by another channel than the link.
- `UnstuckEngineError`: Node binary mode only. The engine binary can't be found, started or kept running.
- `PageClosedError`: exported for code that attaches pages itself. `takeover()` turns a page that is already closed into `failed` with `page_closed`.

## Notes

- Don't `await unstuck.close()` inside `onLink`. `close()` waits for running takeovers, including the one that called it.
- `close()` cancels running takeovers with `engine_closed`. A later `takeover()` starts a new engine.
- The viewer shows "Waiting for the page…" until the first picture arrives. The agent sends a screenshot as the first frame.

On Cloudflare Workers (Durable Objects, Workflows, Browser Rendering): https://unstuck.sh/docs/cloudflare-workers/

License: Apache-2.0, including the engine.
