// Unstuck Browser + Puppeteer: the same wrap, on a Puppeteer page.
//
//   npm init -y && npm pkg set type=module
//   npm install @velmlabs/unstuck puppeteer
//   npx tsx index.ts [url]
import puppeteer from 'puppeteer';
import { Unstuck, UnstuckRescueError } from '@velmlabs/unstuck';

const browser = await puppeteer.launch({ args: process.getuid?.() === 0 ? ['--no-sandbox'] : [] });

// #region snippet
const unstuck = new Unstuck({
  onLink: ({ url, reason }) => console.log(`\n${reason}. Open this link:\n${url}\n`),
});
const page = unstuck.wrap(await browser.newPage(), { remember: true });

try {
  await page.goto(process.argv[2] ?? 'https://www.google.com/recaptcha/api2/demo');
  console.log(`Takeover ${page.unstuck.lastRescue?.status ?? 'not needed'}: now on "${await page.title()}"`);
} catch (e) {
  if (!(e instanceof UnstuckRescueError)) throw e;
  console.log(`Takeover ${e.status}: ${e.message}`);
}
// #endregion snippet

await unstuck.close();
await browser.close();
