import { describe, it, expect } from 'vitest';
import type { ViewerInput } from '@velmlabs/unstuck-protocol';
import { FakeCdp } from '../src/testing';
import { browserPlatformIsMac, translateShortcut } from '../src/stream/shortcuts';

type Key = Extract<ViewerInput, { t: 'key' }>;
const ALT = 1, CTRL = 2, META = 4, SHIFT = 8;
const down = (key: string, modifiers: number, code = key, text?: string): Key => ({ t: 'key', action: 'down', key, code, modifiers, ...(text ? { text } : {}) });
const upk = (key: string, modifiers: number, code = key): Key => ({ t: 'key', action: 'up', key, code, modifiers });
const brief = (ms: Key[]) => ms.map((m) => `${m.action}:${m.key}:${m.modifiers}`);

describe('shortcuts follow the agent browser system', () => {
  describe('agent browser on Windows or Linux', () => {
    const tr = (m: Key) => brief(translateShortcut(m, false));
    it('Cmd+A / Cmd+Z / Cmd+Shift+Z / Cmd+Y → Ctrl', () => {
      expect(tr(down('a', META, 'KeyA'))).toEqual(['down:a:2']);
      expect(tr(down('z', META, 'KeyZ'))).toEqual(['down:z:2']);
      expect(tr(down('z', META | SHIFT, 'KeyZ'))).toEqual(['down:z:10']);
      expect(tr(down('y', META, 'KeyY'))).toEqual(['down:y:2']);
    });
    it('Option+Backspace / Option+Delete / Option+Left/Right → Ctrl', () => {
      expect(tr(down('Backspace', ALT))).toEqual(['down:Backspace:2']);
      expect(tr(down('Delete', ALT))).toEqual(['down:Delete:2']);
      expect(tr(down('ArrowLeft', ALT | SHIFT))).toEqual(['down:ArrowLeft:10']);
      expect(tr(down('ArrowRight', ALT))).toEqual(['down:ArrowRight:2']);
    });
    it('Cmd+Left / Cmd+Right → Home / End, keeping Shift', () => {
      expect(translateShortcut(down('ArrowLeft', META), false)).toEqual([down('Home', 0)]);
      expect(translateShortcut(down('ArrowRight', META | SHIFT), false)).toEqual([down('End', SHIFT)]);
    });
    it('Cmd+Backspace → Shift+Home, then Backspace; its release is a plain Backspace release', () => {
      expect(brief(translateShortcut(down('Backspace', META), false))).toEqual(['down:Home:8', 'up:Home:8', 'down:Backspace:0']);
      expect(brief(translateShortcut(upk('Backspace', META), false))).toEqual(['up:Backspace:0']);
    });
    it('leaves Ctrl shortcuts and Home/End as they are', () => {
      expect(tr(down('a', CTRL, 'KeyA'))).toEqual(['down:a:2']);
      expect(tr(down('Backspace', CTRL))).toEqual(['down:Backspace:2']);
      expect(tr(down('Home', 0))).toEqual(['down:Home:0']);
    });
  });

  describe('agent browser on macOS', () => {
    const tr = (m: Key) => brief(translateShortcut(m, true));
    it('Ctrl+A / Ctrl+Z / Ctrl+Shift+Z → Cmd; Ctrl+Y → Cmd+Shift+Z', () => {
      expect(tr(down('a', CTRL, 'KeyA'))).toEqual(['down:a:4']);
      expect(tr(down('z', CTRL, 'KeyZ'))).toEqual(['down:z:4']);
      expect(tr(down('z', CTRL | SHIFT, 'KeyZ'))).toEqual(['down:z:12']);
      expect(translateShortcut(down('y', CTRL, 'KeyY'), true)).toEqual([down('z', META | SHIFT, 'KeyZ')]);
    });
    it('Ctrl+Backspace / Ctrl+Delete / Ctrl+Left/Right → Option', () => {
      expect(tr(down('Backspace', CTRL))).toEqual(['down:Backspace:1']);
      expect(tr(down('Delete', CTRL))).toEqual(['down:Delete:1']);
      expect(tr(down('ArrowLeft', CTRL))).toEqual(['down:ArrowLeft:1']);
      expect(tr(down('ArrowRight', CTRL | SHIFT))).toEqual(['down:ArrowRight:9']);
    });
    it('Home / End → Cmd+Left / Cmd+Right, keeping Shift', () => {
      expect(translateShortcut(down('Home', SHIFT), true)).toEqual([down('ArrowLeft', META | SHIFT)]);
      expect(translateShortcut(down('End', 0), true)).toEqual([down('ArrowRight', META)]);
    });
    it('leaves Cmd shortcuts as they are', () => {
      expect(tr(down('a', META, 'KeyA'))).toEqual(['down:a:4']);
      expect(tr(down('ArrowLeft', META))).toEqual(['down:ArrowLeft:4']);
    });
  });

  it('never changes plain typing or characters typed with a modifier', () => {
    for (const mac of [true, false]) {
      expect(translateShortcut(down('A', SHIFT, 'KeyA', 'A'), mac)).toEqual([down('A', SHIFT, 'KeyA', 'A')]);
      expect(translateShortcut(down('˚', ALT, 'KeyK', '˚'), mac)).toEqual([down('˚', ALT, 'KeyK', '˚')]);
      expect(translateShortcut(down('Enter', 0, 'Enter', '\r'), mac)).toEqual([down('Enter', 0, 'Enter', '\r')]);
    }
  });

  it('translates a release the same way as its press', () => {
    expect(translateShortcut(upk('a', META, 'KeyA'), false)).toEqual([upk('a', CTRL, 'KeyA')]);
    expect(translateShortcut(upk('ArrowLeft', META), false)).toEqual([upk('Home', 0)]);
    expect(translateShortcut(upk('Home', 0), true)).toEqual([upk('ArrowLeft', META)]);
  });
});

describe('browserPlatformIsMac', () => {
  it('asks the page once per target and caches the answer', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => ({ result: { value: 'MacIntel' } }));
    expect(await browserPlatformIsMac(cdp)).toBe(true);
    expect(await browserPlatformIsMac(cdp)).toBe(true);
    expect(cdp.calls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(1);
    const linux = new FakeCdp();
    linux.respond('Runtime.evaluate', () => ({ result: { value: 'Linux x86_64' } }));
    expect(await browserPlatformIsMac(linux)).toBe(false);
  });
  it('is false when the page cannot answer', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => {
      throw new Error('detached');
    });
    expect(await browserPlatformIsMac(cdp)).toBe(false);
  });
});
