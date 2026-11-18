import { parseArgs, type ParseArgsConfig } from 'node:util';
import { parseRescueKinds } from '../cli';
import type { CheckKind } from '@velmlabs/unstuck-protocol';
import { ShellError } from './tab';

/** parseArgs for a shell command; any problem is a ShellError('usage'). */
export function parseShell<O extends NonNullable<ParseArgsConfig['options']>>(argv: string[], options: O, positionals = false) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: positionals, strict: true });
  } catch (e) {
    throw new ShellError('usage', undefined, (e as Error).message);
  }
}

export const DEFAULT_SHELL_RESCUE: readonly CheckKind[] = ['challenge', 'approval', 'login', '2fa'];

/** `--rescue` or the default scope, as a usage error when it names an unknown kind. */
export function rescueScope(value: string | undefined): CheckKind[] {
  if (value === undefined) return [...DEFAULT_SHELL_RESCUE];
  try {
    return parseRescueKinds(value);
  } catch (e) {
    throw new ShellError('usage', undefined, (e as Error).message);
  }
}

/** `--cdp` or UNSTUCK_CDP_URL. */
export function cdpUrlFrom(value: string | undefined, env: Record<string, string | undefined>): string {
  const url = value ?? env.UNSTUCK_CDP_URL;
  if (!url) throw new ShellError('no_cdp', undefined, 'pass --cdp <url> (e.g. "$(agent-browser get cdp-url)") or set UNSTUCK_CDP_URL');
  return url;
}
