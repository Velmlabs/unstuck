// Minimal Unstuck example: an agent opens a page, asks a human to take over, then continues.
// Run: UNSTUCK_ENGINE_PATH=../../engine/dist/unstuck-engine pnpm start
import { chromium } from 'playwright';
import { Unstuck } from 'unstuck';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(process.argv[2] ?? 'https://www.google.com/recaptcha/api2/demo');

const unstuck = new Unstuck({
  onLink: ({ url, reason }) => console.log(`\n${reason}. Open this on any device:\n${url}\n`),
});

// The agent is paused while this awaits; the human drives the real page.
const result = await unstuck.takeover(page, { reason: 'Please solve the CAPTCHA', timeoutS: 300 });
console.log(`Takeover ${result.status} after ${result.durationS}s`);

if (result.status === 'resolved') {
  // ...carry on with the agent's work here.
  console.log('Agent continues on', page.url());
}

await unstuck.close();
await browser.close();
