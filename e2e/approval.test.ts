// Sign-in approvals end to end: a wrapped Playwright page lands on a "check your phone" prompt, the engine binary runs
// an approval-mode takeover, and either the site moves on by itself (the person approved on their own phone; nobody
// opens the link) or a phone-sized person taps "I've approved it" on the waiting page.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Unstuck, UnstuckRescueError, type TakeoverLink } from '@velmlabs/unstuck';
import { chromium, devices, ENGINE } from './examples/harness';
import { tapStart } from './relay-harness';
import { startApprovalSite, type ApprovalSite } from './browser/approval-site';

let site: ApprovalSite;
let agentBrowser: any;
let humanBrowser: any;
beforeAll(async () => {
  site = await startApprovalSite();
  agentBrowser = await chromium.launch();
  humanBrowser = await chromium.launch();
});
afterAll(async () => {
  await agentBrowser?.close();
  await humanBrowser?.close();
  site?.close();
});
beforeEach(() => {
  site.reset();
  vi.stubEnv('UNSTUCK_HOME', fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-e2e-home-')));
});

describe('sign-in approvals', () => {
  it('approval finishes by itself when the site navigates (nobody opens the link)', async () => {
    const links: TakeoverLink[] = [];
    const unstuck = new Unstuck({
      enginePath: ENGINE,
      onLink: (l) => {
        links.push(l);
        site.approve(); // the person approves the push on their own phone; the link is never opened
      },
    });
    const ctx = await agentBrowser.newContext();
    const page = unstuck.wrap(await ctx.newPage());
    await page.goto(`${site.url}/login`);
    expect(await page.title()).toBe('Inbox');
    expect(page.unstuck.lastRescue).toMatchObject({ status: 'resolved', check: { kind: 'approval' }, takeover: { status: 'resolved', detail: 'approval_navigated' } });
    expect(links).toHaveLength(1);
    expect(links[0]!.reason).toMatch(/asks you to approve a sign-in/);
    expect(site.hits('/inbox')).toBe(1);
    await unstuck.close();
    await ctx.close();
  });

  it("approval: I've approved it with the prompt still there is still_blocked", async () => {
    let link!: TakeoverLink;
    let arrived!: () => void;
    const got = new Promise<void>((r) => (arrived = r));
    const unstuck = new Unstuck({ enginePath: ENGINE, onLink: (l) => ((link = l), arrived()) });
    const ctx = await agentBrowser.newContext();
    const page = unstuck.wrap(await ctx.newPage());
    const going = page.goto(`${site.url}/login`).catch((e: unknown) => e);
    await got;

    const phone = await humanBrowser.newContext({ ...devices['iPhone 13'] });
    const human = await phone.newPage();
    await human.goto(link.url);
    await tapStart(human);
    // The waiting page, not the live view: the person approves on their own device.
    await human.getByRole('heading', { name: link.reason }).waitFor({ timeout: 15_000 });
    await expect(human.getByText('Watching the page for your approval').isVisible()).resolves.toBe(true);
    await human.getByRole('button', { name: "I've approved it" }).click(); // ...but they haven't: the prompt stays
    await human.getByText('Checking the page…').waitFor({ timeout: 5_000 });

    const err = await going;
    expect(err).toBeInstanceOf(UnstuckRescueError);
    expect(err).toMatchObject({ status: 'still_blocked', detail: 'approval_still_showing', check: { kind: 'approval' } });
    // The session judged the page itself: the phone and the end report see it was not approved.
    expect((err as UnstuckRescueError).event.takeover).toMatchObject({ status: 'failed', detail: 'still_blocked:approval_still_showing' });
    await human.getByRole('heading', { name: "The sign-in didn't go through" }).waitFor({ timeout: 5_000 });
    expect(await page.title()).toBe('Sign in to Example Mail');
    expect(site.hits('/inbox')).toBe(0);
    await phone.close();
    await unstuck.close();
    await ctx.close();
  });
});
