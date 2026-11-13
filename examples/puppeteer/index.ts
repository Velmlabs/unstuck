// Unstuck + Puppeteer: an agent opens a page, asks a human to take over, then carries on.
//
//   npm init -y && npm pkg set type=module
//   npm install @velmlabs/unstuck puppeteer
//   npx tsx index.ts [url]
//
// Add UNSTUCK_API_KEY=uk_live_… to your environment to send the link through Unstuck Cloud.
import puppeteer from 'puppeteer';
import { Unstuck } from '@velmlabs/unstuck';

const browser = await puppeteer.launch();
const [page] = await browser.pages();
await page!.setViewport({ width: 1280, height: 720 });
await page!.goto(process.argv[2] ?? 'https://www.google.com/recaptcha/api2/demo');

// #region snippet
const unstuck = new Unstuck({
  onLink: ({ url, reason }) => console.log(`\n${reason}. Open this link:\n${url}\n`),
});

// Pass Puppeteer's page as is: the agent waits while a person solves it.
const result = await unstuck.takeover(page!, { reason: 'Please log in', timeoutS: 300 });
console.log(`Takeover ${result.status} after ${result.durationS}s`);
// #endregion snippet

await unstuck.close();
await browser.close();
