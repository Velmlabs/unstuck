import { describe, it, expect } from 'vitest';
import { keyEventToMessage, modifiersOf } from '../src/keys';

const ev = (o: Partial<KeyboardEvent> & { type: string; key: string }) =>
  ({ code: '', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...o }) as KeyboardEvent;

describe('keyEventToMessage', () => {
  it('printable key down carries text', () => {
    expect(keyEventToMessage(ev({ type: 'keydown', key: 'a', code: 'KeyA' }))).toEqual({ t: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 });
  });

  it('Ctrl+C has no text and modifiers 2', () => {
    expect(keyEventToMessage(ev({ type: 'keydown', key: 'c', code: 'KeyC', ctrlKey: true }))).toEqual({ t: 'key', action: 'down', key: 'c', code: 'KeyC', modifiers: 2 });
  });

  it('Enter has text \\r', () => {
    expect(keyEventToMessage(ev({ type: 'keydown', key: 'Enter', code: 'Enter' }))).toMatchObject({ text: '\r' });
  });

  it('non-printable keys have no text; key up never has text', () => {
    expect(keyEventToMessage(ev({ type: 'keydown', key: 'ArrowLeft', code: 'ArrowLeft' }))).not.toHaveProperty('text');
    expect(keyEventToMessage(ev({ type: 'keyup', key: 'a', code: 'KeyA' }))).toEqual({ t: 'key', action: 'up', key: 'a', code: 'KeyA', modifiers: 0 });
  });

  it('returns null while composing (IME) and for other event types', () => {
    expect(keyEventToMessage(ev({ type: 'keydown', key: 'a', isComposing: true }))).toBeNull();
    expect(keyEventToMessage(ev({ type: 'keypress', key: 'a' }))).toBeNull();
    expect(keyEventToMessage(ev({ type: 'keydown', key: 'Process' }))).toBeNull();
    expect(keyEventToMessage(ev({ type: 'keydown', key: 'Unidentified' }))).toBeNull();
  });

  it('modifiersOf follows CDP bits: Alt=1 Ctrl=2 Meta=4 Shift=8', () => {
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
    expect(keyEventToMessage(ev({ type: 'keydown', key: 'A', code: 'KeyA', shiftKey: true }))).toMatchObject({ text: 'A', modifiers: 8 });
  });
});
