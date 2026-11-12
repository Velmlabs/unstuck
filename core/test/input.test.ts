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

  it('printable key down → keyDown with text and unmodifiedText', async () => {
    expect(await run({ t: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 })).toEqual([
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 0, text: 'a', unmodifiedText: 'a' } },
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
