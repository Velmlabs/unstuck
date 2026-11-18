// Page-less questions end to end: the TypeScript SDK asks through the engine binary, and the person answers on the
// question page (local viewer) or with a Telegram quick-answer button (through relay-node).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Unstuck, type TakeoverLink } from '@velmlabs/unstuck';
import { RelaySession, type RelayEvent } from '@velmlabs/unstuck-relay-core';
import { chromium, devices, ENGINE } from './examples/harness';
import { RELAY_KEY, startRelay, tapStart } from './relay-harness';

let humanBrowser: any;
beforeAll(async () => (humanBrowser = await chromium.launch()));
afterAll(async () => humanBrowser?.close());

/** Resolves with the first link the SDK hands out. */
function linkCatcher() {
  let arrived!: (l: TakeoverLink) => void;
  const link = new Promise<TakeoverLink>((r) => (arrived = r));
  return { link, onLink: (l: TakeoverLink) => arrived(l) };
}

describe('ask(): a question for the person', () => {
  it('ask over the local viewer: Playwright opens the link, taps a choice, the SDK gets the answer', async () => {
    const unstuck = new Unstuck({ enginePath: ENGINE, agentName: 'Invoice bot' });
    const c = linkCatcher();
    const asked = unstuck.ask('Which billing plan should I pick?', { choices: ['Basic', 'Pro', 'Team'], details: 'Pro adds the API; Team adds three seats.', onLink: c.onLink });
    const link = await c.link;
    expect(link.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[A-Za-z0-9_-]{22}#t=/);

    const phone = await humanBrowser.newContext({ ...devices['iPhone 13'] });
    const human = await phone.newPage();
    await human.goto(link.url);
    await tapStart(human);
    await human.getByRole('heading', { name: 'Which billing plan should I pick?' }).waitFor({ timeout: 15_000 });
    await expect(human.getByText('Invoice bot asks').isVisible()).resolves.toBe(true);
    await human.getByRole('button', { name: 'Pro' }).click();
    await human.getByRole('button', { name: 'Send answer' }).click();

    await expect(asked).resolves.toMatchObject({ status: 'answered', answer: { choice: 1, label: 'Pro' }, via: 'page' });
    await human.getByRole('heading', { name: 'Answer sent' }).waitFor({ timeout: 10_000 });
    await phone.close();
    await unstuck.close();
  });
});

describe('ask() through relay-node', () => {
  let relay: { url: string; stop(): Promise<void> };
  const events: RelayEvent[] = [];
  /** The relay's session object per session id (relay-node keeps them private: captured as each agent attaches). */
  const sessions = new Map<string, RelaySession>();
  const attachAgent = RelaySession.prototype.attachAgent;
  beforeAll(async () => {
    RelaySession.prototype.attachAgent = function (this: RelaySession, ...args) {
      sessions.set(this.record.sessionId, this);
      return attachAgent.apply(this, args);
    };
    relay = await startRelay('node', { onEvent: (e) => void events.push(e) });
  });
  afterAll(async () => {
    RelaySession.prototype.attachAgent = attachAgent;
    await relay?.stop();
  });
  afterEach(() => void (events.length = 0));

  it('ask through relay-node, then quick_answer injected via RelaySession.quickAnswer, gives via telegram', async () => {
    const unstuck = new Unstuck({ enginePath: ENGINE, relay: relay.url, agentKey: RELAY_KEY });
    const c = linkCatcher();
    // private: false with choices: the question may be answered with a button on the phone alert.
    const asked = unstuck.ask('Reply to the recruiter now?', { choices: ['Yes', 'Later'], private: false, onLink: c.onLink });
    const link = await c.link;
    expect(link.url.startsWith(relay.url.replace('ws://', 'http://'))).toBe(true);
    // Unstuck Cloud's Telegram button lands here: the relay sends the agent a quick_answer frame.
    expect(sessions.get(link.sessionId)?.quickAnswer(1)).toBe(true);

    await expect(asked).resolves.toMatchObject({ status: 'answered', answer: { choice: 1, label: 'Later' }, via: 'telegram' });
    await expect.poll(() => events.some((e) => e.name === 'session_closed' && e.sessionId === link.sessionId), { timeout: 10_000 }).toBe(true);
    // Nobody opened the link: a quick answer is never charged.
    expect(events.filter((e) => e.name === 'takeover_opened')).toEqual([]);
    expect(events.find((e) => e.name === 'session_closed')).toMatchObject({ mode: 'question', viewers: 0 });
    await unstuck.close();
  });

  it('a private question ignores a quick answer: only the page can answer it', async () => {
    const unstuck = new Unstuck({ enginePath: ENGINE, relay: relay.url, agentKey: RELAY_KEY });
    const c = linkCatcher();
    const asked = unstuck.ask('Which card should I use?', { choices: ['Visa', 'Amex'], timeoutS: 10, onLink: c.onLink });
    const link = await c.link;
    expect(sessions.get(link.sessionId)?.quickAnswer(0)).toBe(true); // the relay passes it on; the engine ignores it
    await expect(asked).resolves.toMatchObject({ status: 'timed_out' });
    await unstuck.close();
  }, 30_000);
});
