// Unstuck + Playwright: an agent opens a page, asks a human to take over, then carries on.
//
//   npm init -y && npm pkg set type=module
//   npm install @velmlabs/unstuck playwright
//   npx playwright install chromium
//   npx tsx index.ts [url]
//
// Add UNSTUCK_API_KEY=uk_live_… to your environment to send the link through Unstuck Cloud,
// so it opens on any phone, from anywhere.
import { chromium } from 'playwright';
import { Unstuck } from '@velmlabs/unstuck';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(process.argv[2] ?? 'https://www.google.com/recaptcha/api2/demo');

// #region snippet
const unstuck = new Unstuck({
  onLink: ({ url, reason }) => console.log(`\n${reason}. Open this link:\n${url}\n`),
});

// The agent waits here while a person solves the page in the real browser.
const result = await unstuck.takeover(page, { reason: 'Please solve the CAPTCHA', timeoutS: 300 });
console.log(`Takeover ${result.status} after ${result.durationS}s`);

if (result.status === 'resolved') {
  // ...carry on with the agent's work here.
}
// #endregion snippet

await unstuck.close();
await browser.close();
