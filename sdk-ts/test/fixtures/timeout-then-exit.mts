// Child process for Review Focus 5: must exit by itself after a timed-out takeover.
import { createRequire } from 'node:module';
import { Unstuck } from '../../src/index';

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch();
const page = await browser.newPage();
const unstuck = new Unstuck({ onLink: () => {} });
const result = await unstuck.takeover(page, { reason: 'x', timeoutS: 1 });
console.log(result.status);
await unstuck.close();
await browser.close();
