import type { ViewerInput } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';
import type { Capabilities } from '../capabilities';

const VIRTUAL_KEYS: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

const MOUSE_TYPES = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' } as const;

/** Replays one viewer input message into the page via CDP Input.* */
export async function applyInput(cdp: CdpClient, msg: ViewerInput, caps?: Capabilities): Promise<void> {
  switch (msg.t) {
    case 'mouse':
      await cdp.send('Input.dispatchMouseEvent', {
        type: MOUSE_TYPES[msg.action],
        x: msg.x,
        y: msg.y,
        button: msg.button,
        clickCount: msg.clickCount,
        modifiers: msg.modifiers,
      });
      return;
    case 'wheel':
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: msg.x, y: msg.y, deltaX: msg.dx, deltaY: msg.dy });
      return;
    case 'key': {
      const base = { key: msg.key, code: msg.code, modifiers: msg.modifiers };
      const vk = VIRTUAL_KEYS[msg.key];
      const withVk = vk === undefined ? {} : { windowsVirtualKeyCode: vk };
      if (msg.action === 'up') await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      else if (msg.text !== undefined)
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: msg.text, unmodifiedText: msg.text, ...withVk });
      else await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...withVk });
      return;
    }
    case 'text':
      if (caps?.insertText === false) {
        // Fallback: type each Unicode code point as a key press.
        for (const ch of msg.text) {
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
        }
        return;
      }
      await cdp.send('Input.insertText', { text: msg.text });
      return;
  }
}
