import type { ViewerToEngine } from '@unstuck/protocol';

type Mods = Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>;

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function modifiersOf(e: Mods): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export function keyEventToMessage(
  e: Pick<KeyboardEvent, 'type' | 'key' | 'code' | 'isComposing'> & Mods,
): Extract<ViewerToEngine, { t: 'key' }> | null {
  if (e.isComposing || e.key === 'Process' || e.key === 'Unidentified') return null;
  if (e.type !== 'keydown' && e.type !== 'keyup') return null;
  const modifiers = modifiersOf(e);
  const base = { t: 'key' as const, action: e.type === 'keydown' ? ('down' as const) : ('up' as const), key: e.key, code: e.code, modifiers };
  if (base.action === 'up') return base;
  if (e.key === 'Enter') return { ...base, text: '\r' };
  if ([...e.key].length === 1 && !e.ctrlKey && !e.metaKey) return { ...base, text: e.key };
  return base;
}
