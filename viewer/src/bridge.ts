// The keyboard bridge: an invisible input the phone's keyboard types into. Everything typed goes straight to the
// agent's real page and nothing stays here. Key presses go first, as key presses with their modifiers, so the page
// sees keydown/keyup as if typed there; text events are the fallback for input that never comes as a key press
// (Android keyboards, IME composition, autocorrect, paste, the SMS code suggestion). The bridge holds a reserve of
// invisible characters so Backspace always has something to delete: iOS only repeats a held Backspace while text
// really changes (measured on an iPad).
import type { FieldKind, ViewerInput } from '@velmlabs/unstuck-protocol';
import { keyEventToMessage } from './keys';

type Key = Extract<ViewerInput, { t: 'key' }>;
export const RESERVE = 64;
export const LOW = 16;
const ZW = '​';
const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'Symbol', 'AltGraph'];
/** A key press and its text event arriving within this window are one key, not two. */
const SAME_KEY_MS = 50;
const ENTER_SUBMIT_MS = 300;
const DELETE_BACK = ['deleteContentBackward', 'deleteWordBackward', 'deleteSoftLineBackward', 'deleteHardLineBackward', 'deleteByCut'];
const DELETE_FWD = ['deleteContentForward', 'deleteWordForward', 'deleteSoftLineForward', 'deleteHardLineForward'];

const ATTRS: Record<FieldKind, { inputMode: string; autocomplete: string; type: string }> = {
  otp: { inputMode: 'numeric', autocomplete: 'one-time-code', type: 'text' },
  numeric: { inputMode: 'numeric', autocomplete: 'off', type: 'text' },
  email: { inputMode: 'email', autocomplete: 'off', type: 'text' },
  password: { inputMode: 'text', autocomplete: 'off', type: 'password' },
  text: { inputMode: 'text', autocomplete: 'off', type: 'text' },
};

function refill(input: HTMLInputElement): void {
  input.value = ZW.repeat(RESERVE);
  try {
    input.setSelectionRange(RESERVE, RESERVE);
  } catch {
    // some input types don't support selection; the reserve still works
  }
}

/** Sets the bridge up for a kind of field: which keyboard opens, whether the SMS code is offered. */
export function configureBridge(input: HTMLInputElement, kind: FieldKind): void {
  const a = ATTRS[kind];
  input.type = a.type;
  input.inputMode = a.inputMode;
  input.setAttribute('autocomplete', a.autocomplete);
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('enterkeyhint', 'go');
  refill(input);
}

const codeFor = (ch: string) => (/^[0-9]$/.test(ch) ? `Digit${ch}` : /^[a-zA-Z]$/.test(ch) ? `Key${ch.toUpperCase()}` : '');
/** A short code (an SMS code, a PIN) arriving in one piece, in a code field, is typed key by key. */
const looksLikeCode = (text: string, kind: FieldKind | null) => (kind === 'otp' || kind === 'numeric') && text.length <= 12 && !/\s/.test(text);

export function attachBridge(
  input: HTMLInputElement,
  form: HTMLFormElement,
  opts: { send: (m: ViewerInput) => void; kind: () => FieldKind | null; now?: () => number },
): () => void {
  const now = opts.now ?? (() => performance.now());
  let lastBackspaceKeyAt = -Infinity;
  let lastEnterKeyAt = -Infinity;
  let compositionSent = false;

  const tap = (key: string, code: string, text?: string) => {
    opts.send({ t: 'key', action: 'down', key, code, modifiers: 0, ...(text !== undefined ? { text } : {}) });
    opts.send({ t: 'key', action: 'up', key, code, modifiers: 0 });
  };
  const sendText = (text: string) => {
    if (looksLikeCode(text, opts.kind())) for (const ch of text) tap(ch, codeFor(ch), ch);
    else opts.send({ t: 'text', text });
  };
  const forward = (e: KeyboardEvent): Key | null => {
    if (MODIFIER_KEYS.includes(e.key) || e.keyCode === 229) return null;
    return keyEventToMessage(e); // null for composing, Unidentified/Process and copy/paste/cut
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const m = forward(e);
    if (!m) return;
    const plainBackspace = e.key === 'Backspace' && !e.altKey && !e.ctrlKey && !e.metaKey;
    // A plain Backspace may really delete one invisible character, so iOS keeps repeating it while held.
    if (plainBackspace) lastBackspaceKeyAt = now();
    else e.preventDefault(); // keeps focus on Tab, and the bridge never edits itself
    if (e.key === 'Enter') lastEnterKeyAt = now();
    opts.send(m);
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const m = forward(e);
    if (m) opts.send(m);
  };

  const onBeforeInput = (e: InputEvent) => {
    const t = e.inputType;
    if (t === 'insertCompositionText') return; // sent when the composition ends
    if (t === 'deleteContentBackward') {
      if (now() - lastBackspaceKeyAt >= SAME_KEY_MS) tap('Backspace', 'Backspace');
      return; // let it delete one invisible character
    }
    e.preventDefault();
    if (DELETE_BACK.includes(t)) return tap('Backspace', 'Backspace');
    if (DELETE_FWD.includes(t)) return tap('Delete', 'Delete');
    if (t === 'insertLineBreak' || t === 'insertParagraph') {
      if (now() - lastEnterKeyAt >= SAME_KEY_MS) tap('Enter', 'Enter', '\r');
      return;
    }
    const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
    if (!text) return;
    if (t === 'insertFromComposition') compositionSent = true;
    sendText(text);
  };

  const onCompositionEnd = (e: CompositionEvent) => {
    if (!compositionSent && e.data) sendText(e.data);
    compositionSent = false;
    refill(input);
  };

  // Anything that still landed in the bridge (a browser that skipped beforeinput) is sent, then the reserve restored.
  const onInput = (e: Event) => {
    if ((e as InputEvent).isComposing) return;
    const leftover = input.value.split(ZW).join('');
    if (leftover) sendText(leftover);
    if (leftover || input.value.length < LOW) refill(input);
  };

  // Go/Return on a keyboard that reports no key still submits the form around the bridge.
  const onSubmit = (e: SubmitEvent) => {
    e.preventDefault();
    if (now() - lastEnterKeyAt >= ENTER_SUBMIT_MS) tap('Enter', 'Enter', '\r');
    input.focus({ preventScroll: true });
  };

  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('keyup', onKeyUp);
  input.addEventListener('beforeinput', onBeforeInput);
  input.addEventListener('compositionend', onCompositionEnd);
  input.addEventListener('input', onInput);
  form.addEventListener('submit', onSubmit);
  refill(input);
  return () => {
    input.removeEventListener('keydown', onKeyDown);
    input.removeEventListener('keyup', onKeyUp);
    input.removeEventListener('beforeinput', onBeforeInput);
    input.removeEventListener('compositionend', onCompositionEnd);
    input.removeEventListener('input', onInput);
    form.removeEventListener('submit', onSubmit);
  };
}
