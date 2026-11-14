// Editing shortcuts differ between macOS and other systems (Cmd+A vs Ctrl+A, Option+Backspace vs Ctrl+Backspace…).
// The person's keyboard and the agent's browser may be on different systems, so shortcuts are translated to the
// agent browser's system. Plain keys, and characters typed with a modifier (Option+K → ˚), are never changed.
import type { ViewerInput } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';

type Key = Extract<ViewerInput, { t: 'key' }>;
const ALT = 1, CTRL = 2, META = 4, SHIFT = 8;
const EDIT_LETTERS = ['a', 'z', 'y'];
const WORD_KEYS = ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight'];

const swap = (m: number, from: number, to: number) => (m & ~from) | to;
const only = (m: number, mod: number) => (m & ~SHIFT) === mod; // that modifier (and maybe Shift), nothing else
const withKey = (msg: Key, key: string, modifiers: number, code = key): Key => {
  const { text: _text, ...rest } = msg;
  return { ...rest, key, code, modifiers };
};

/** The key messages the agent's browser should receive for one key message from the viewer. */
export function translateShortcut(msg: Key, browserIsMac: boolean): Key[] {
  if (msg.text !== undefined) return [msg]; // it types a character: leave it alone
  const m = msg.modifiers;
  const letter = msg.key.toLowerCase();
  if (!browserIsMac) {
    if (only(m, META) && EDIT_LETTERS.includes(letter)) return [{ ...msg, modifiers: swap(m, META, CTRL) }];
    if (only(m, ALT) && WORD_KEYS.includes(msg.key)) return [{ ...msg, modifiers: swap(m, ALT, CTRL) }];
    if (only(m, META) && (msg.key === 'ArrowLeft' || msg.key === 'ArrowRight')) return [withKey(msg, msg.key === 'ArrowLeft' ? 'Home' : 'End', m & SHIFT)];
    if (only(m, META) && msg.key === 'Backspace') {
      // Delete to the start of the line: select it, then delete the selection.
      if (msg.action === 'up') return [withKey(msg, 'Backspace', 0)];
      return [withKey(msg, 'Home', SHIFT), { ...withKey(msg, 'Home', SHIFT), action: 'up' }, withKey(msg, 'Backspace', 0)];
    }
    return [msg];
  }
  if (only(m, CTRL) && letter === 'y') return [withKey(msg, 'z', META | SHIFT, 'KeyZ')]; // redo on macOS
  if (only(m, CTRL) && EDIT_LETTERS.includes(letter)) return [{ ...msg, modifiers: swap(m, CTRL, META) }];
  if (only(m, CTRL) && WORD_KEYS.includes(msg.key)) return [{ ...msg, modifiers: swap(m, CTRL, ALT) }];
  if ((m & ~SHIFT) === 0 && (msg.key === 'Home' || msg.key === 'End')) return [withKey(msg, msg.key === 'Home' ? 'ArrowLeft' : 'ArrowRight', META | (m & SHIFT))];
  return [msg];
}

const platforms = new WeakMap<CdpClient, Promise<boolean>>();

/** Whether the agent's browser runs on macOS (asked once per target; false if it can't be told). */
export function browserPlatformIsMac(cdp: CdpClient): Promise<boolean> {
  let p = platforms.get(cdp);
  if (!p) {
    p = cdp
      .send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: 'navigator.platform', returnByValue: true })
      .then((r) => /^mac/i.test(String(r?.result?.value ?? '')))
      .catch(() => {
        platforms.delete(cdp); // a page mid-navigation: ask again on the next key instead of guessing forever
        return false;
      });
    platforms.set(cdp, p);
  }
  return p;
}
