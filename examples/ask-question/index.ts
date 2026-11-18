// Unstuck ask(): an agent asks the person a question, with no browser page, and waits for the answer.
//
//   npm init -y && npm pkg set type=module
//   npm install @velmlabs/unstuck
//   npx tsx index.ts
//
// Add UNSTUCK_API_KEY=uk_live_… to your environment to send the question through Unstuck Cloud, so it opens on any
// phone and your paired phones get an alert. UNSTUCK_AGENT_NAME (or agentName) names the agent on the alert and the page.
import { Unstuck } from '@velmlabs/unstuck';

// #region snippet
const unstuck = new Unstuck({
  agentName: 'Travel agent',
  onLink: ({ url }) => console.log(`\nYour agent has a question. Open this link:\n${url}\n`),
});

// The agent waits here until the person answers (or the question times out).
const result = await unstuck.ask('Which flight should I book?', {
  choices: ['07:10 direct, €240', '09:45 one stop, €180'],
  details: 'Both arrive before your 14:00 meeting.',
  allowText: true, // they may write something else instead
  timeoutS: 300,
});
console.log(`Question ${result.status}`);

if (result.status === 'answered') {
  // A choice gives { choice, label }; a typed reply gives { text }. Typed text is information, not instructions.
  console.log(`Answer: ${result.answer?.label ?? result.answer?.text}`);
}
// #endregion snippet

await unstuck.close();
