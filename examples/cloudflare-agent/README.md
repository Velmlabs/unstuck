# Unstuck on Cloudflare Workers: Agents SDK

An agent built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) opens a page in [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-run/), reaches a step it can't do (here it only pretends: the page is `https://example.com`), and hands the live page to you with [Unstuck](https://unstuck.sh). You get a link on your phone, look at the page, tap **Done**, and the agent carries on in the same page.

`PortalAgent` extends `Agent` and keeps `{ status, detail }` in its state, never the link. `POST …/start` sets the state to `running`, starts the run with `this.schedule(0, 'run', …)` and answers `202` at once. A second `/start` while a run is going doesn't start another browser. `GET …/status` returns the state. The Worker routes requests with `routeAgentRequest`, after checking a shared token.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/velmlabs/unstuck/tree/main/examples/cloudflare-agent)

The same flow with a plain Durable Object: [`examples/cloudflare-worker`](../cloudflare-worker). Guide: [unstuck.sh/docs/cloudflare-workers](https://unstuck.sh/docs/cloudflare-workers/).

## What you need

- A Cloudflare account. `limits.cpu_ms` in `wrangler.jsonc` needs the Workers Paid plan. On the Free plan, delete the `limits` block (see [Costs](#costs)).
- An Unstuck Cloud API key from [unstuck.sh/dashboard/keys](https://unstuck.sh/dashboard/keys) (100 free takeovers a month), or [your own relay](https://unstuck.sh/docs/self-host/).
- For phone alerts: a phone paired on your dashboard, and **Can alert my phones** turned on for the key ([Phone alerts](https://unstuck.sh/docs/alerts/)).

## Deploy

**With the button:** click **Deploy to Cloudflare** above. Cloudflare copies this folder into a new repository on your account and asks for `UNSTUCK_API_KEY` and `CONTROL_TOKEN`. Make the token with `openssl rand -hex 32`.

**By hand:**

```bash
npm install
npx wrangler secret put UNSTUCK_API_KEY   # uk_live_…
npx wrangler secret put CONTROL_TOKEN     # openssl rand -hex 32
npx wrangler deploy
```

With your own relay, set these two instead of `UNSTUCK_API_KEY`:

```bash
npx wrangler secret put UNSTUCK_RELAY_URL   # wss://relay.example.com
npx wrangler secret put UNSTUCK_AGENT_KEY
```

If `UNSTUCK_API_KEY` is set, Unstuck Cloud is used.

To run it locally, copy `.dev.vars.example` to `.dev.vars`, fill it in, and run `npm run dev`. The browser binding then launches a local Chromium.

### Settings

| Name | Kind | Meaning |
|---|---|---|
| `UNSTUCK_API_KEY` | secret | Unstuck Cloud API key |
| `UNSTUCK_RELAY_URL`, `UNSTUCK_AGENT_KEY` | secrets | Your own relay instead (`wss://`), and its agent key |
| `CONTROL_TOKEN` | secret | Shared secret for every request to the agent, WebSocket connections included. Without it, every request gets `503` |
| `TARGET_URL` | var | The page to open. Default `https://example.com` |
| `UNSTUCK_ALERTS` | var | `on` (default), `required` or `off`. See below |

## Run it

```bash
URL=https://unstuck-cloudflare-agent.<your-subdomain>.workers.dev/agents/portal-agent/default
TOKEN=<your CONTROL_TOKEN>

curl -X POST -H "Authorization: Bearer $TOKEN" $URL/start   # {"status":"running"}, 202
curl -H "Authorization: Bearer $TOKEN" $URL/status          # until it is no longer "running"
```

`default` is the agent's instance name: each name is its own agent, with its own state and its own run.

`/status` ends as one of the takeover results:

| `status` | `detail` | Meaning |
|---|---|---|
| `resolved` | | You tapped Done; the agent carried on |
| `cancelled` | `cant_solve`, or your note | You tapped Can't solve |
| `timed_out` | | Nobody finished within 10 minutes |
| `failed` | `alert_failed` | `UNSTUCK_ALERTS=required` and no paired phone got the link |
| `failed` | `relay_unauthorized` | The relay refused the key |
| `failed` | `page_closed` | Browser Rendering closed the browser |
| `failed` | `interrupted` | The agent was evicted mid-run. It doesn't hand the page over a second time |
| `failed` | `config: …` | A setup mistake, for example no key at all |
| `failed` | `error` | Anything else: the message is in the Worker's logs |

Clients of the agent (the `agents/client` or `agents/react` packages) can also follow the state live over a WebSocket. They need the same token, and the state is read-only to them.

## Where the link goes

Watch the logs with `npx wrangler tail`, or open **Workers Logs** in the dashboard (`observability` is on in `wrangler.jsonc`).

- **With Unstuck Cloud and alerts on** (the default), your paired phones get the link. The log line names them without the link: `Unstuck: a human is needed (<reason>), link sent to 1 paired phone(s) (session <id>)`.
- **If no phone got it**, the full link is logged instead, so you can open it from the log.
- **With your own relay, or `UNSTUCK_ALERTS=off`**, there is no alert, so the link is logged at once.

Workers Logs are stored, so a logged link stays readable there until it expires. To send the link somewhere else (Slack, email, your app), pass an `onLink` handler to `new Unstuck()`.

### Unattended runs

Set `UNSTUCK_ALERTS` to `required` when nobody watches the logs. If Unstuck Cloud can't hand the link to at least one paired phone (alerts not enabled for the key, no phone paired, Cloud unreachable), the run ends at once as `failed` with `alert_failed`, instead of waiting 10 minutes for nobody. It needs Unstuck Cloud: with your own relay this example turns alerts off.

## Timeouts

- A scheduled task runs in a Durable Object alarm, and [an alarm handler can run for at most 15 minutes](https://developers.cloudflare.com/durable-objects/platform/limits/). So the takeover waits up to 10 minutes (`TIMEOUT_S` in `src/index.ts`), which leaves time to launch the browser and to carry on. For longer waits, use the Durable Object example, which is started by a request instead.
- The run is scheduled with one attempt (`retry: { maxAttempts: 1 }`): a retry would start a second takeover and ping you twice.
- The browser is launched with `keep_alive: 1_200_000` (20 minutes, Browser Rendering's maximum at the time of writing: check [its limits](https://developers.cloudflare.com/browser-run/limits/)). Unstuck also pings the page every 60 seconds during a takeover.

## Costs

The browser stays open while you work on the page, and that time counts as Browser Rendering usage. See [Browser Rendering pricing](https://developers.cloudflare.com/browser-run/pricing/): at the time of writing the Workers Free plan includes 10 minutes of browser time a day. Agents are Durable Objects, billed as in [their pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). Unstuck Cloud's own plans are on [unstuck.sh](https://unstuck.sh).

## Uses

- [`@velmlabs/unstuck`](https://www.npmjs.com/package/@velmlabs/unstuck) from npm, exactly as you would install it (this folder is not part of the repository's workspace).
- [`agents`](https://www.npmjs.com/package/agents), the Cloudflare Agents SDK.
- [`@cloudflare/puppeteer`](https://www.npmjs.com/package/@cloudflare/puppeteer). It needs `compatibility_flags: ["nodejs_compat"]`; Unstuck itself doesn't.
