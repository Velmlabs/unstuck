# Unstuck

**Human takeover for AI browser agents.** When your agent gets stuck on a CAPTCHA, a login wall, a 2FA prompt or any page that needs a person, Unstuck pauses it, sends someone a link, lets them work the live browser from their phone, and hands control back.

![The Unstuck viewer on a phone: the agent's live page with Keyboard, Can't solve and Done buttons](docs/screenshots/viewer-live-iphone13.png)

## Install

```bash
npm install @velmlabs/unstuck
```

```bash
pip install unstuck
```

The engine comes with the package for macOS, Linux and Windows; there is nothing else to install.

## One call where your agent gets stuck

```ts
import { chromium } from 'playwright';
import { Unstuck } from '@velmlabs/unstuck';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://www.google.com/recaptcha/api2/demo');

const unstuck = new Unstuck({ onLink: ({ url }) => console.log('Open this on any device:', url) });
const result = await unstuck.takeover(page, { reason: 'Please solve the CAPTCHA' });
console.log(result.status); // 'resolved' | 'cancelled' | 'timed_out' | 'failed'
```

The person opens the link, sees your agent's live page, taps and types into it, then taps **Done**. `takeover()` returns and your agent carries on.

## Works with

| Stack | Guide | Example |
|---|---|---|
| MCP: Claude Code, Claude Desktop, Cursor, Playwright MCP | [unstuck.sh/docs/mcp](https://unstuck.sh/docs/mcp) | [`examples/mcp`](examples/mcp) |
| Playwright (TypeScript, Python) | [unstuck.sh/docs/playwright](https://unstuck.sh/docs/playwright) | [`examples/playwright-ts`](examples/playwright-ts), [`examples/playwright-py`](examples/playwright-py) |
| Puppeteer | [unstuck.sh/docs/puppeteer](https://unstuck.sh/docs/puppeteer) | [`examples/puppeteer`](examples/puppeteer) |
| browser-use, Stagehand | [unstuck.sh/docs/ai-agents](https://unstuck.sh/docs/ai-agents) | [`examples/browser-use`](examples/browser-use), [`examples/stagehand`](examples/stagehand) |
| Any Chromium over CDP, Selenium, hosted browsers | [unstuck.sh/docs/any-browser](https://unstuck.sh/docs/any-browser) | [`examples/cdp`](examples/cdp), [`examples/selenium`](examples/selenium) |

Full docs: **https://unstuck.sh/docs**

## MCP in one line

```bash
claude mcp add unstuck -e UNSTUCK_CDP_URL=http://127.0.0.1:9222 -- npx -y @velmlabs/unstuck-engine --mcp --open
```

Your agent gets a `request_human_takeover` tool that attaches to the Chrome on port 9222.

## Local or Unstuck Cloud

| | Where the link works | Set |
|---|---|---|
| Local (default) | on the agent's own machine | nothing |
| [Unstuck Cloud](https://unstuck.sh) (100 free takeovers a month) | any phone, from anywhere | `UNSTUCK_API_KEY=uk_live_…` |
| Your own relay | wherever you host it | `UNSTUCK_RELAY_URL` and `UNSTUCK_AGENT_KEY` |

Run your own relay on Node or Docker (`relay-node/`) or on Cloudflare Workers (`relay-cloudflare/`).

## Security

- Each link carries a single-use token and a fresh encryption key in the URL fragment, which never reaches a server or log.
- The screen, taps and keystrokes are encrypted end to end (AES-GCM) between your agent's engine and the person's browser. A relay, Unstuck Cloud included, only sees ciphertext.
- One person at a time; an optional 6-digit code means a forwarded link alone isn't enough.
- The audit log records states and input counts, never what was typed.

## Develop

```bash
pnpm install
pnpm test
pnpm --filter @velmlabs/unstuck-engine build
pnpm e2e:examples
```

Every package keeps test coverage above 90%. `pnpm e2e:examples` runs each example against a real browser and a simulated person on a phone.

## License

- SDKs, engine, protocol, MCP server and integrations: [Apache-2.0](LICENSE-APACHE)
- Relay and viewer: [AGPL-3.0](LICENSE-AGPL)
