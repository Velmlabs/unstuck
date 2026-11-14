import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FieldKind, ViewerInput } from '@velmlabs/unstuck-protocol';
import { attachBridge, configureBridge, RESERVE, LOW } from '../src/bridge';

const ZW = '​';
let input: HTMLInputElement;
let form: HTMLFormElement;
let sent: ViewerInput[];
let kind: FieldKind | null;
let clock: number;
let detach: () => void;

beforeEach(() => {
  form = document.createElement('form');
  input = document.createElement('input');
  form.append(input);
  document.body.append(form);
  sent = [];
  kind = 'text';
  clock = 1000;
  detach = attachBridge(input, form, { send: (m) => sent.push(m), kind: () => kind, now: () => clock });
  configureBridge(input, 'text');
  input.focus();
});
afterEach(() => {
  detach();
  form.remove();
});

const key = (type: 'keydown' | 'keyup', init: KeyboardEventInit) => {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(e);
  return e;
};
const before = (inputType: string, data: string | null = null, dataTransfer?: { getData(t: string): string }) => {
  const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data });
  if (dataTransfer) Object.defineProperty(e, 'dataTransfer', { value: dataTransfer });
  input.dispatchEvent(e);
  return e;
};
const keys = () => sent.map((m) => (m.t === 'key' ? `${m.action}:${m.key}:${m.modifiers}${m.text !== undefined ? ':' + JSON.stringify(m.text) : ''}` : `text:${JSON.stringify((m as { text: string }).text)}`));
const onlyReserve = () => [...input.value].every((c) => c === ZW) && input.value.length >= LOW;

describe('keyboard bridge', () => {
  it('starts with a full reserve of invisible characters', () => {
    expect(input.value).toBe(ZW.repeat(RESERVE));
  });

  it('a printable key goes as a key press with its modifiers and text, and its release', () => {
    const d = key('keydown', { key: 'A', code: 'KeyA', shiftKey: true });
    key('keyup', { key: 'A', code: 'KeyA', shiftKey: true });
    expect(d.defaultPrevented).toBe(true);
    expect(sent).toEqual([
      { t: 'key', action: 'down', key: 'A', code: 'KeyA', text: 'A', modifiers: 8 },
      { t: 'key', action: 'up', key: 'A', code: 'KeyA', modifiers: 8 },
    ]);
  });

  it('keys that type nothing go as key presses too, and Tab keeps focus on the bridge', () => {
    const cases: [KeyboardEventInit, string][] = [
      [{ key: 'Tab', code: 'Tab' }, 'down:Tab:0'],
      [{ key: 'Tab', code: 'Tab', shiftKey: true }, 'down:Tab:8'],
      [{ key: 'ArrowLeft', code: 'ArrowLeft' }, 'down:ArrowLeft:0'],
      [{ key: 'Home', code: 'Home' }, 'down:Home:0'],
      [{ key: 'PageDown', code: 'PageDown' }, 'down:PageDown:0'],
      [{ key: 'Escape', code: 'Escape' }, 'down:Escape:0'],
      [{ key: 'Delete', code: 'Delete' }, 'down:Delete:0'],
      [{ key: 'Enter', code: 'Enter' }, 'down:Enter:0:"\\r"'],
      [{ key: 'F5', code: 'F5' }, 'down:F5:0'],
      [{ key: 'a', code: 'KeyA', ctrlKey: true }, 'down:a:2'],
      [{ key: 'a', code: 'KeyA', metaKey: true }, 'down:a:4'],
    ];
    for (const [init, want] of cases) {
      sent = [];
      const e = key('keydown', init);
      key('keyup', init);
      expect(e.defaultPrevented, want).toBe(true);
      expect(keys()[0], want).toBe(want);
      expect(sent[1], want).toMatchObject({ action: 'up', key: init.key });
    }
    expect(document.activeElement).toBe(input);
  });

  it('modifier keys alone send nothing, and copy/paste/cut stay native', () => {
    for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) {
      key('keydown', { key: k });
      key('keyup', { key: k });
    }
    for (const [k, mod] of [['c', 'ctrlKey'], ['v', 'metaKey'], ['x', 'ctrlKey']] as const) {
      const e = key('keydown', { key: k, code: `Key${k.toUpperCase()}`, [mod]: true });
      key('keyup', { key: k, code: `Key${k.toUpperCase()}`, [mod]: true });
      expect(e.defaultPrevented).toBe(false);
    }
    expect(sent).toEqual([]);
  });

  it('a plain Backspace deletes one invisible character for real, so a held Backspace keeps repeating', () => {
    const d = key('keydown', { key: 'Backspace', code: 'Backspace' });
    expect(d.defaultPrevented).toBe(false);
    clock += 10;
    const b = before('deleteContentBackward');
    expect(b.defaultPrevented).toBe(false);
    key('keyup', { key: 'Backspace', code: 'Backspace' });
    expect(keys()).toEqual(['down:Backspace:0', 'up:Backspace:0']);
  });

  it('a delete with no key press (Android) sends one Backspace', () => {
    clock += 1000;
    const b = before('deleteContentBackward');
    expect(b.defaultPrevented).toBe(false);
    expect(keys()).toEqual(['down:Backspace:0', 'up:Backspace:0']);
  });

  it('word and line deletes send one Backspace; a forward delete sends Delete', () => {
    for (const t of ['deleteWordBackward', 'deleteSoftLineBackward']) expect(before(t).defaultPrevented).toBe(true);
    expect(before('deleteContentForward').defaultPrevented).toBe(true);
    expect(keys()).toEqual(['down:Backspace:0', 'up:Backspace:0', 'down:Backspace:0', 'up:Backspace:0', 'down:Delete:0', 'up:Delete:0']);
  });

  it('keyboards that hide their keys (Android) are caught by the text event', () => {
    key('keydown', { key: 'Unidentified', keyCode: 229 } as KeyboardEventInit);
    before('insertText', 'x');
    expect(keys()).toEqual(['text:"x"']);
  });

  it('autocorrect, paste and drop send their text', () => {
    before('insertReplacementText', 'hello');
    before('insertFromPaste', null, { getData: () => 'pasted' });
    before('insertFromDrop', null, { getData: () => 'dropped' });
    expect(keys()).toEqual(['text:"hello"', 'text:"pasted"', 'text:"dropped"']);
  });

  it('in a code field a short code becomes key presses; long or spaced text stays one message', () => {
    kind = 'otp';
    before('insertText', '482913');
    expect(keys()).toEqual(['4', '8', '2', '9', '1', '3'].flatMap((d) => [`down:${d}:0:"${d}"`, `up:${d}:0`]));
    expect(sent[0]).toMatchObject({ code: 'Digit4' });
    sent = [];
    before('insertFromPaste', null, { getData: () => 'https://x.example/' });
    before('insertText', '12 34');
    expect(keys()).toEqual(['text:"https://x.example/"', 'text:"12 34"']);
    kind = 'email';
    sent = [];
    before('insertText', '482913');
    expect(keys()).toEqual(['text:"482913"']);
  });

  it('composition (IME) is sent once when it ends', () => {
    expect(before('insertCompositionText', '日').defaultPrevented).toBe(false);
    input.dispatchEvent(new CompositionEvent('compositionend', { data: '日本', bubbles: true }));
    expect(keys()).toEqual(['text:"日本"']);
  });

  it('a composition committed by insertFromComposition (Safari) is not sent again at compositionend', () => {
    before('insertFromComposition', '日本');
    input.dispatchEvent(new CompositionEvent('compositionend', { data: '日本', bubbles: true }));
    expect(keys()).toEqual(['text:"日本"']);
  });

  it('Go/Return that only submits the form sends Enter once and keeps focus; after an Enter key press it sends nothing', () => {
    form.requestSubmit();
    expect(keys()).toEqual(['down:Enter:0:"\\r"', 'up:Enter:0']);
    expect(document.activeElement).toBe(input);
    sent = [];
    key('keydown', { key: 'Enter', code: 'Enter' });
    key('keyup', { key: 'Enter', code: 'Enter' });
    clock += 100;
    form.requestSubmit();
    expect(keys()).toEqual(['down:Enter:0:"\\r"', 'up:Enter:0']);
  });

  it('never keeps typed text: anything that slips into the bridge is sent and the reserve restored', () => {
    input.value = ZW.repeat(10) + 'ab';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'ab' }));
    expect(keys()).toEqual(['text:"ab"']);
    expect(onlyReserve()).toBe(true);
    input.value = ZW.repeat(LOW - 1);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    expect(input.value).toBe(ZW.repeat(RESERVE));
    before('insertText', 'secret');
    expect(onlyReserve()).toBe(true);
  });

  it('configures the keyboard for each kind', () => {
    const attrs = () => [input.inputMode, input.getAttribute('autocomplete'), input.type];
    configureBridge(input, 'otp');
    expect(attrs()).toEqual(['numeric', 'one-time-code', 'text']);
    configureBridge(input, 'numeric');
    expect(attrs()).toEqual(['numeric', 'off', 'text']);
    configureBridge(input, 'email');
    expect(attrs()).toEqual(['email', 'off', 'text']);
    configureBridge(input, 'password');
    expect(attrs()).toEqual(['text', 'off', 'password']);
    configureBridge(input, 'text');
    expect(attrs()).toEqual(['text', 'off', 'text']);
    for (const [a, v] of ([['autocorrect', 'off'], ['autocapitalize', 'off'], ['spellcheck', 'false'], ['enterkeyhint', 'go']] as const)) expect(input.getAttribute(a)).toBe(v);
    expect(input.value).toBe(ZW.repeat(RESERVE));
  });

  it('detaching stops forwarding', () => {
    detach();
    key('keydown', { key: 'a', code: 'KeyA' });
    expect(sent).toEqual([]);
    detach = () => {};
  });
});
