import { sendTakeoverAlert, type AlertOutcome, type CloudAlerter, type LinkInfo, type TakeoverControl } from '@velmlabs/unstuck-core';

/**
 * The phone alert for a question session (stdio host and MCP server alike): kind `question`, no site (a question has no
 * page), and the question text and choices as a quick answer only when the question isn't private and has choices
 * (Cloud rejects a readable question without choices).
 */
export function sendAskAlert(
  alerter: CloudAlerter | undefined,
  alerts: boolean | 'required' | undefined,
  info: LinkInfo,
  takeover: TakeoverControl,
  ask: { question: string; choices?: string[]; private?: boolean },
): Promise<AlertOutcome> | null {
  const quick = ask.private === false && ask.choices ? { question: ask.question, choices: ask.choices } : undefined;
  return sendTakeoverAlert(alerter, alerts, { ...info, kind: 'question' }, undefined, takeover, quick);
}
