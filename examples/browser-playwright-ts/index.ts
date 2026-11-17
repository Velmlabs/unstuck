// Unstuck Browser + Playwright: wrap the page once, and any CAPTCHA or "verify you are human" check a navigation or
// click lands on brings a person in. The agent's own call returns once they're past it.
//
//   npm init -y && npm pkg set type=module
//   npm install @velmlabs/unstuck playwright
//   npx playwright install chromium
//   npx tsx index.ts [url]
//
// Add UNSTUCK_API_KEY=uk_live_… to your environment to send the link through Unstuck Cloud,
// so it opens on any phone, from anywhere.
import { chromium } from 'playwright';
import { Unstuck, UnstuckRescueError } from '@velmlabs/unstuck';

const browser = await chromium.launch();

// #region snippet
const unstuck = new Unstuck({
  onLink: ({ url, reason }) => console.log(`\n${reason}. Open this link:\n${url}\n`),
});
const page = unstuck.wrap(await browser.newPage(), { remember: true });

try {
  // A check on this page brings a person in; goto returns once they're past it.
  await page.goto(process.argv[2] ?? 'https://www.google.com/recaptcha/api2/demo');
  console.log(`Takeover ${page.unstuck.lastRescue?.status ?? 'not needed'}: now on "${await page.title()}"`);
  // ...carry on with the agent's work here.
} catch (e) {
  if (!(e instanceof UnstuckRescueError)) throw e;
  console.log(`Takeover ${e.status}: ${e.message}`);
}
// #endregion snippet

await unstuck.close();
await browser.close();
