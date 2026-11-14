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

`result.status` is `resolved`, `timed_out`, `cancelled` (the human tapped "Can't solve") or `failed` (for example the page closed). `takeover()` only rejects with `UnstuckEngineError` when the engine binary can't run.

The engine comes with the package: npm installs the build for your computer (macOS 13+ on Apple silicon or Intel, Linux with glibc, Windows x64). To use another binary, set `UNSTUCK_ENGINE_PATH` or the `enginePath` option.

Send the link through Unstuck Cloud, so it opens on any phone, by setting `UNSTUCK_API_KEY=uk_live_…`. Tutorials for Playwright, Puppeteer, MCP, browser-use, Stagehand and any Chromium: https://unstuck.sh/docs

License: Apache-2.0, including the engine.
