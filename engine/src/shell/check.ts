import { detectHumanCheck } from '@velmlabs/unstuck-core';
import { connectCdp } from '../direct-cdp';
import { cdpUrlFrom, parseShell, rescueScope } from './args';
import { EXIT, emit } from './output';
import { ShellError, resolveTab } from './tab';

interface IO {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

/** Reports a ShellError as exit 2: `{ error, message, ...extra }`. */
export function usageError(io: IO, e: unknown): number {
  if (!(e instanceof ShellError)) throw e;
  return emit(io, { error: e.code, message: e.message, ...(e.extra ?? {}) }, EXIT.usage, e.message);
}

/**
 * `unstuck check --cdp <url> [--tab <targetId>] [--url <requested>] [--rescue <kinds>]`: whether the tab shows a human
 * check, and which. Reads the page only: no navigation, no input, no cookies.
 */
export async function runCheck(argv: string[], io: IO, env: Record<string, string | undefined>): Promise<number> {
  try {
    const { values } = parseShell(argv, { cdp: { type: 'string' }, tab: { type: 'string' }, url: { type: 'string' }, rescue: { type: 'string' } });
    const scope = rescueScope(values.rescue);
    const tab = await resolveTab(cdpUrlFrom(values.cdp, env), values.tab);
    const cdp = await connectCdp(tab.browserWsUrl, { targetId: tab.targetId });
    try {
      const found = await detectHumanCheck(cdp, { scope, ...(values.url ? { requestedUrl: values.url } : {}) });
      if (!found) return emit(io, { status: 'clear' }, EXIT.done);
      const check = { kind: found.kind, ...(found.vendor ? { vendor: found.vendor } : {}), site: found.site, rule: found.ruleId };
      return emit(io, { status: 'check_found', check }, EXIT.checkFound, `A ${found.kind} check is on ${found.site}: run unstuck rescue to bring a person in.`);
    } finally {
      await cdp.close();
    }
  } catch (e) {
    return usageError(io, e);
  }
}
