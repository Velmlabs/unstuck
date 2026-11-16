# Unstuck on Cloudflare Workers: Durable Object

A Durable Object opens a page in [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-run/), reaches a step it can't do (here it only pretends: the page is `https://example.com`), and hands the live page to you with [Unstuck](https://unstuck.sh). You get a link on your phone, look at the page, tap **Done**, and the agent carries on in the same page.

It follows the pattern in the guide, [unstuck.sh/docs/cloudflare-workers](https://unstuck.sh/docs/cloudflare-workers/): `POST /start` answers `202` at once and the takeover runs on in the object (`ctx.waitUntil`). A second `/start` while a run is going doesn't start another browser. `GET /status` returns `{ status, detail }`, never the link.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/velmlabs/unstuck/tree/main/examples/cloudflare-worker)

The same flow with the Agents SDK: [`examples/cloudflare-agent`](../cloudflare-agent).

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
npx wrangler secret put LINK_WEBHOOK_URL    # recommended: see Where the link goes
```

A relay that runs as a Worker on the same Cloudflare account works over its `workers.dev` address thanks to the `global_fetch_strictly_public` flag in `wrangler.jsonc`. Without that flag, Cloudflare refuses the Worker-to-Worker request (error 1042) and the takeover fails.

If `UNSTUCK_API_KEY` is set, Unstuck Cloud is used.

To run it locally, copy `.dev.vars.example` to `.dev.vars`, fill it in, and run `npm run dev`. The browser binding then launches a local Chromium.

### Settings

| Name | Kind | Meaning |
|---|---|---|
| `UNSTUCK_API_KEY` | secret | Unstuck Cloud API key |
| `UNSTUCK_RELAY_URL`, `UNSTUCK_AGENT_KEY` | secrets | Your own relay instead (`wss://`), and its agent key |
| `CONTROL_TOKEN` | secret | Shared secret for `/start` and `/status`. Without it, every request gets `503` |
| `TARGET_URL` | var | The page to open. Default `https://example.com` |
| `UNSTUCK_ALERTS` | var | `on` (default), `required` or `off`. See below |
| `LINK_WEBHOOK_URL` | secret, optional | An incoming webhook (`https://`) that gets the link at once. See below |

## Run it

```bash
URL=https://unstuck-cloudflare-worker.<your-subdomain>.workers.dev
TOKEN=<your CONTROL_TOKEN>

curl -X POST -H "Authorization: Bearer $TOKEN" $URL/start   # {"status":"running"}, 202
curl -H "Authorization: Bearer $TOKEN" $URL/status          # until it is no longer "running"
```

`/status` ends as one of the takeover results:

| `status` | `detail` | Meaning |
|---|---|---|
| `resolved` | | You tapped Done; the agent carried on |
| `cancelled` | `cant_solve`, or your note | You tapped Can't solve |
| `timed_out` | | Nobody finished within 15 minutes |
| `failed` | `alert_failed` | `UNSTUCK_ALERTS=required` and no paired phone got the link |
| `failed` | `relay_unauthorized` | The relay refused the key |
| `failed` | `page_closed` | Browser Rendering closed the browser |
| `failed` | `config: …` | A setup mistake, for example no key at all |
| `failed` | `error` | Anything else: the message is in the Worker's logs |

## Where the link goes

- **With Unstuck Cloud and alerts on** (the default), your paired phones get the link at once. This is the way to go.
- **With `LINK_WEBHOOK_URL` set**, the link is also POSTed to that webhook at once, as JSON: `{ text, content, url, reason, sessionId, expiresAt }`. `text` makes a Slack incoming webhook show it, `content` a Discord one; your own endpoint can read the other fields. The request gives up after 5 seconds, and a failure is logged without the link. Use this with a self-hosted relay, which sends no phone alerts.
- **Otherwise the link goes to the logs** (`npx wrangler tail`, or **Workers Logs** in the dashboard; `observability` is on in `wrangler.jsonc`). With alerts on, the log line names the phones instead: `Unstuck: a human is needed (<reason>), link sent to 1 paired phone(s) (session <id>)`. The full link is logged only when no phone got it, or when there is no alert (your own relay, or `UNSTUCK_ALERTS=off`).

**The logs come too late to act on.** Workers Logs and `wrangler tail` show a Durable Object's logs only when the invocation that wrote them ends, and here that is the whole run: you see the link only after the takeover has ended, usually by timing out. So don't rely on the log for the link: use phone alerts (Unstuck Cloud) or `LINK_WEBHOOK_URL`.

The link carries the session's secret. It never goes into the object's state or `/status`. Workers Logs are stored, so a logged link stays readable there until it expires.

### Unattended runs

Set `UNSTUCK_ALERTS` to `required` when nobody watches the logs. If Unstuck Cloud can't hand the link to at least one paired phone (alerts not enabled for the key, no phone paired, Cloud unreachable), the run ends at once as `failed` with `alert_failed`, instead of waiting 15 minutes for nobody. It needs Unstuck Cloud: with your own relay this example turns alerts off.

## Timeouts

- The takeover waits up to 15 minutes (`TIMEOUT_S` in `src/index.ts`).
- The browser is launched with `keep_alive: 1_200_000` (20 minutes, Browser Rendering's maximum at the time of writing: check [its limits](https://developers.cloudflare.com/browser-run/limits/)). Unstuck also pings the page every 60 seconds during a takeover.
- If the object is evicted mid-run, `/status` stays `running`; a new `/start` begins again once the run is older than its timeout plus 2 minutes.

## Costs

The browser stays open while you work on the page, and that time counts as Browser Rendering usage. See [Browser Rendering pricing](https://developers.cloudflare.com/browser-run/pricing/): at the time of writing the Workers Free plan includes 10 minutes of browser time a day. Durable Objects are billed as in [their pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). Unstuck Cloud's own plans are on [unstuck.sh](https://unstuck.sh).

## Uses

- [`@velmlabs/unstuck`](https://www.npmjs.com/package/@velmlabs/unstuck) from npm, exactly as you would install it (this folder is not part of the repository's workspace).
- [`@cloudflare/puppeteer`](https://www.npmjs.com/package/@cloudflare/puppeteer). It needs `compatibility_flags: ["nodejs_compat"]`; Unstuck itself doesn't.
