// Unstuck + any Chromium you can reach over CDP: a hosted browser (Browserbase, Steel, …), a Chrome started
// with --remote-debugging-port, or the browser inside another framework. Unstuck takes over the agent's tab.
//
//   npm install @velmlabs/unstuck playwright
//   CDP_URL=http://127.0.0.1:9222 AGENT_URL_PART=/checkout npx tsx index.ts
//
// On a server or in CI, add UNSTUCK_API_KEY=uk_live_… so the link goes through Unstuck Cloud and opens anywhere.
import { chromium } from 'playwright';
import { Unstuck } from '@velmlabs/unstuck';
import { agentPage } from './agent-page';

// #region snippet
// Attach to the running browser; nothing is launched or closed.
const browser = await chromium.connectOverCDP(process.env.CDP_URL ?? 'http://127.0.0.1:9222');
const page = await agentPage(browser, process.env.AGENT_URL_PART);
console.log('Taking over', page.url());

const unstuck = new Unstuck({
  onLink: ({ url, reason }) => console.log(`\n${reason}. Open this on any device:\n${url}\n`),
});
const result = await unstuck.takeover(page, { reason: 'Please solve this step', timeoutS: 300 });
console.log(`Takeover ${result.status} after ${result.durationS}s`);
// #endregion snippet

await unstuck.close();
process.exit(0); // the browser isn't ours to close: just let go of it
