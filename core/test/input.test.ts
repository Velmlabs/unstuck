import { describe, it, expect } from 'vitest';
import { FakeCdp } from '../src/testing';
import { applyInput } from '../src/stream/input';

async function run(msg: Parameters<typeof applyInput>[1]) {
  const cdp = new FakeCdp();
  await applyInput(cdp, msg);
  return cdp.calls;
}

describe('applyInput', () => {
  it.each([
    ['down', 'mousePressed'],
    ['up', 'mouseReleased'],
    ['move', 'mouseMoved'],
  ] as const)('mouse %s → %s', async (action, type) => {
    expect(await run({ t: 'mouse', action, x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 8 })).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type, x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 8 } },
    ]);
  });

  it('wheel → mouseWheel with deltas', async () => {
    expect(await run({ t: 'wheel', x: 1, y: 2, dx: 3, dy: -4 })).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 1, y: 2, deltaX: 3, deltaY: -4 } },
    ]);
  });

  it('printable key down → keyDown with text, unmodifiedText and its virtual key code', async () => {
    expect(await run({ t: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 })).toEqual([
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 0, text: 'a', unmodifiedText: 'a', windowsVirtualKeyCode: 65 } },
    ]);
  });

  it('non-printable key down → rawKeyDown with a virtual key code', async () => {
    expect(await run({ t: 'key', action: 'down', key: 'Backspace', code: 'Backspace', modifiers: 0 })).toEqual([
      { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', modifiers: 0, windowsVirtualKeyCode: 8 } },
    ]);
  });

  it('Enter carries text \\r and virtual key code 13', async () => {
    const [call] = await run({ t: 'key', action: 'down', key: 'Enter', code: 'Enter', text: '\r', modifiers: 0 });
    expect(call!.params).toMatchObject({ type: 'keyDown', text: '\r', windowsVirtualKeyCode: 13 });
  });

  it.each([
    ['Tab', 9],
    ['Escape', 27],
    ['ArrowLeft', 37],
    ['ArrowUp', 38],
    ['ArrowRight', 39],
    ['ArrowDown', 40],
    ['Delete', 46],
  ])('%s has virtual key code %i', async (key, vk) => {
    const [call] = await run({ t: 'key', action: 'down', key, code: key, modifiers: 0 });
    expect(call!.params).toMatchObject({ windowsVirtualKeyCode: vk });
  });

  it('key up → keyUp without text', async () => {
    expect(await run({ t: 'key', action: 'up', key: 'a', code: 'KeyA', modifiers: 2 })).toEqual([
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 } },
    ]);
  });

  it('text → Input.insertText (unicode preserved)', async () => {
    expect(await run({ t: 'text', text: 'héllo 日本' })).toEqual([{ method: 'Input.insertText', params: { text: 'héllo 日本' } }]);
  });
});

describe('applyInput per-key fallback (no Input.insertText)', () => {
  it('types text as one keyDown + keyUp per Unicode code point', async () => {
    const cdp = new FakeCdp();
    await applyInput(cdp, { t: 'text', text: 'héllo 日本' }, { screencast: true, insertText: false, input: true });
    expect(cdp.calls).toHaveLength(16);
    expect(cdp.calls.slice(0, 2)).toEqual([
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'h', text: 'h', unmodifiedText: 'h' } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'h' } },
    ]);
    expect(cdp.calls[14]!.params).toMatchObject({ type: 'keyDown', key: '本', text: '本' });
  });

  it('keeps using insertText when it is supported', async () => {
    const cdp = new FakeCdp();
    await applyInput(cdp, { t: 'text', text: 'ab' }, { screencast: true, insertText: true, input: true });
    expect(cdp.calls).toEqual([{ method: 'Input.insertText', params: { text: 'ab' } }]);
  });

  it('every key gets its Windows virtual key code: Home, End, Page keys, Insert, F-keys, letters and digits', async () => {
    const vk = async (key: string, text?: string) =>
      ((await run({ t: 'key', action: 'down', key, code: key, modifiers: 0, ...(text ? { text } : {}) }))[0]!.params as { windowsVirtualKeyCode?: number }).windowsVirtualKeyCode;
    expect(await vk('Home')).toBe(36);
    expect(await vk('End')).toBe(35);
    expect(await vk('PageUp')).toBe(33);
    expect(await vk('PageDown')).toBe(34);
    expect(await vk('Insert')).toBe(45);
    expect(await vk('F1')).toBe(112);
    expect(await vk('F5')).toBe(116);
    expect(await vk('F12')).toBe(123);
    expect(await vk('a', 'a')).toBe(65);
    expect(await vk('A', 'A')).toBe(65);
    expect(await vk('7', '7')).toBe(55);
    expect(await vk('˚', '˚')).toBeUndefined();
  });
});
