// Unstuck + Stagehand: Stagehand drives the browser; when act() can't get past a CAPTCHA or a login,
// Unstuck hands the same browser to a person and returns once they're done.
//
//   npm install @velmlabs/unstuck @browserbasehq/stagehand playwright
//   ANTHROPIC_API_KEY=… npx tsx index.ts [url]
//
// CHROME_PATH picks a Chrome binary if Stagehand can't find one. Add UNSTUCK_API_KEY=uk_live_… for Unstuck Cloud.
import { Stagehand, localBrowser } from '@browserbasehq/stagehand';
import { chromium } from 'playwright';
import { Unstuck } from '@velmlabs/unstuck';

const browser = await localBrowser.launch({ executablePath: process.env.CHROME_PATH, headless: true });
const stagehand = await Stagehand.create({ browser });

// Playwright on the same browser, over Stagehand's CDP URL: Unstuck takes a Playwright page.
const pw = await chromium.connectOverCDP(browser.cdpUrl!);
const context = pw.contexts()[0]!;
const page = context.pages().find((p) => p.url() !== 'about:blank') ?? (await context.newPage());
await page.goto(process.argv[2] ?? 'https://www.google.com/recaptcha/api2/demo');

if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
  await stagehand.act('submit the form');
} else {
  console.log('There is no model key, so act() is skipped and we ask for help directly.');
}

// #region snippet
// Stuck? Hand the same page to a person.
const unstuck = new Unstuck({
  onLink: ({ url, reason }) => console.log(`\n${reason}. Open this on any device:\n${url}\n`),
});
const result = await unstuck.takeover(page, { reason: 'Please solve the CAPTCHA', timeoutS: 300 });
console.log(`Takeover ${result.status} after ${result.durationS}s`);
// #endregion snippet

await unstuck.close();
await stagehand.close();
await browser.close();
process.exit(0);
