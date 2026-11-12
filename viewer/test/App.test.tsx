import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/preact';
import type { ConnectionHandlers } from '../src/connection';
import { App, type AppProps } from '../src/App';

const NOW = 1_700_000_000_000;
let handlers: ConnectionHandlers;
let sent: unknown[];
let closed: boolean;
const connectFn: AppProps['connectFn'] = (_url, _token, h) => {
  handlers = h;
  return { send: (m) => void sent.push(m), close: () => void (closed = true) };
};
const loc = (hash = '#t=TOK') => ({ hash, pathname: '/s/SESSION', origin: 'http://127.0.0.1:5000' });
const drawFrame = vi.fn();
/** Dispatch a real (jsdom) MouseEvent under a pointer event name; jsdom has no PointerEvent. */
function pointer(el: Element, type: 'pointerdown' | 'pointerup' | 'pointermove', init: MouseEventInit) {
  act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })));
}

function setup(hash?: string) {
  const r = render(<App location={loc(hash)} connectFn={connectFn} drawFrame={drawFrame} now={() => NOW} />);
  return r;
}
function goLive() {
  act(() => {
    handlers.onPhase('connecting');
    handlers.onReady({ t: 'ready', reason: 'Solve the CAPTCHA', site: 'shop.example', expiresAt: NOW + 125_000, resumeKey: 'k' });
    handlers.onPhase('live');
    handlers.onFrame({ width: 1280, height: 720, jpeg: new Uint8Array([1]) });
  });
  const canvas = screen.getByTestId('screen') as HTMLCanvasElement;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON: () => ({}) });
  return canvas;
}

beforeEach(() => {
  sent = [];
  closed = false;
  drawFrame.mockClear();
});
afterEach(() => cleanup());

describe('App', () => {
  it('shows an invalid-link screen when the URL has no token, without connecting', () => {
    handlers = undefined as never;
    setup('');
    expect(screen.getByRole('heading').textContent).toMatch(/not valid/i);
    expect(handlers).toBeUndefined();
  });

  it('shows connecting, then reason, site and a countdown once ready', () => {
    setup();
    expect(screen.getByRole('status').textContent).toMatch(/connecting/i);
    goLive();
    expect(screen.getByText('Solve the CAPTCHA')).toBeTruthy();
    expect(screen.getByText('shop.example')).toBeTruthy();
    expect(screen.getByTestId('countdown').textContent).toBe('2:05');
  });

  it('the countdown ticks every second and stops at 0:00', () => {
    vi.useFakeTimers();
    let t = NOW;
    try {
      render(<App location={loc()} connectFn={connectFn} drawFrame={drawFrame} now={() => t} />);
      act(() => handlers.onReady({ t: 'ready', reason: 'r', site: '', expiresAt: NOW + 2_000, resumeKey: 'k' }));
      t += 1_000;
      act(() => void vi.advanceTimersByTime(1_000));
      expect(screen.getByTestId('countdown').textContent).toBe('0:01');
      t += 5_000;
      act(() => void vi.advanceTimersByTime(1_000));
      expect(screen.getByTestId('countdown').textContent).toBe('0:00');
    } finally {
      vi.useRealTimers();
    }
  });

  it('draws incoming frames on the canvas', () => {
    setup();
    goLive();
    expect(drawFrame).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), { width: 1280, height: 720, jpeg: new Uint8Array([1]) });
  });

  it('maps taps to page coordinates (Review Focus 1)', () => {
    setup();
    const canvas = goLive();
    pointer(canvas, 'pointerdown', { clientX: 320, clientY: 180, button: 0 });
    pointer(canvas, 'pointerup', { clientX: 320, clientY: 180, button: 0 });
    expect(sent).toEqual([
      { t: 'mouse', action: 'down', x: 640, y: 360, button: 'left', clickCount: 1, modifiers: 0 },
      { t: 'mouse', action: 'up', x: 640, y: 360, button: 'left', clickCount: 1, modifiers: 0 },
    ]);
  });

  it('right and middle buttons map to CDP names', () => {
    setup();
    const canvas = goLive();
    pointer(canvas, 'pointerdown', { clientX: 1, clientY: 1, button: 2 });
    pointer(canvas, 'pointerdown', { clientX: 1, clientY: 1, button: 1 });
    expect(sent.map((m) => (m as { button: string }).button)).toEqual(['right', 'middle']);
  });

  it('ignores taps in the letterbox and before the first frame', () => {
    setup();
    act(() => handlers.onPhase('live'));
    const canvas = screen.getByTestId('screen');
    pointer(canvas, 'pointerdown', { clientX: 10, clientY: 10, button: 0 });
    expect(sent).toEqual([]);
    const c = goLive();
    c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 390, height: 844, right: 390, bottom: 844, x: 0, y: 0, toJSON: () => ({}) });
    pointer(c, 'pointerdown', { clientX: 100, clientY: 20, button: 0 });
    expect(sent).toEqual([]);
  });

  it('throttles pointer moves to one per animation frame', async () => {
    setup();
    const canvas = goLive();
    pointer(canvas, 'pointermove', { clientX: 10, clientY: 10, buttons: 1 });
    pointer(canvas, 'pointermove', { clientX: 20, clientY: 20, buttons: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: 'mouse', action: 'move', button: 'left' });
    await new Promise((r) => setTimeout(r, 40));
    pointer(canvas, 'pointermove', { clientX: 30, clientY: 30, buttons: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ button: 'none' });
  });

  it('suppresses the context menu on the canvas', () => {
    setup();
    const canvas = goLive();
    const e = new MouseEvent('contextmenu', { cancelable: true });
    act(() => void canvas.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
  });

  it('sends wheel events', () => {
    setup();
    const canvas = goLive();
    act(() => void canvas.dispatchEvent(new WheelEvent('wheel', { clientX: 320, clientY: 180, deltaX: 0, deltaY: 120, cancelable: true })));
    expect(sent).toEqual([{ t: 'wheel', x: 640, y: 360, dx: 0, dy: 120 }]);
  });

  it('forwards physical keyboard events and paste while live', () => {
    setup();
    goLive();
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA' });
    fireEvent.keyUp(window, { key: 'a', code: 'KeyA' });
    const paste = new Event('paste') as Event & { clipboardData: { getData(t: string): string } };
    paste.clipboardData = { getData: () => 'héllo 日本' };
    act(() => void window.dispatchEvent(paste));
    expect(sent).toEqual([
      { t: 'key', action: 'down', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 },
      { t: 'key', action: 'up', key: 'a', code: 'KeyA', modifiers: 0 },
      { t: 'text', text: 'héllo 日本' },
    ]);
  });

  it('does not forward keys before going live', () => {
    setup();
    fireEvent.keyDown(window, { key: 'a', code: 'KeyA' });
    expect(sent).toEqual([]);
  });

  it('Done sends done', () => {
    setup();
    goLive();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(sent).toEqual([{ t: 'done' }]);
  });

  it("Can't solve asks for an optional reason, keeps keystrokes local, then sends it", () => {
    setup();
    goLive();
    fireEvent.click(screen.getByRole('button', { name: "Can't solve" }));
    const input = screen.getByLabelText(/what went wrong/i) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'b', code: 'KeyB' });
    fireEvent.input(input, { target: { value: 'blurry' } });
    fireEvent.click(screen.getByRole('button', { name: /send to agent/i }));
    expect(sent).toEqual([{ t: 'cant_solve', reason: 'blurry' }]);
  });

  it("Can't solve can be dismissed, and an empty reason is omitted", () => {
    setup();
    goLive();
    fireEvent.click(screen.getByRole('button', { name: "Can't solve" }));
    fireEvent.click(screen.getByRole('button', { name: /keep trying/i }));
    expect(screen.queryByLabelText(/what went wrong/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: "Can't solve" }));
    fireEvent.click(screen.getByRole('button', { name: /send to agent/i }));
    expect(sent).toEqual([{ t: 'cant_solve' }]);
  });

  it.each([
    ['token_used', /already in use/i],
    ['expired', /expired/i],
    ['token_invalid', /not valid/i],
    ['session_closed', /has ended/i],
  ] as const)('error %s shows its screen (Review Focus 2)', (code, text) => {
    setup();
    act(() => handlers.onError(code, 'm'));
    expect(screen.getByRole('heading').textContent).toMatch(text);
  });

  it('a non-fatal bad_message error keeps the live screen', () => {
    setup();
    goLive();
    act(() => handlers.onError('bad_message', 'm'));
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it.each([
    ['resolved', /all done/i],
    ['cancelled', /handed back/i],
    ['timed_out', /time ran out/i],
    ['failed', /page closed|went wrong/i],
  ] as const)('final state %s shows a finished screen and closes the socket', (status, text) => {
    setup();
    goLive();
    act(() => handlers.onState(status));
    expect(screen.getByRole('heading').textContent).toMatch(text);
    expect(closed).toBe(true);
  });

  it('non-terminal states keep the live screen', () => {
    setup();
    goLive();
    act(() => handlers.onState('active'));
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('shows a reconnecting banner and a connection-lost screen', () => {
    setup();
    goLive();
    act(() => handlers.onPhase('reconnecting'));
    expect(screen.getByRole('status').textContent).toMatch(/reconnecting/i);
    act(() => handlers.onPhase('closed'));
    expect(screen.getByRole('heading').textContent).toMatch(/connection lost/i);
  });

  it('touch keyboard bridge: insertText, Backspace, Enter and IME composition', () => {
    setup();
    goLive();
    fireEvent.click(screen.getByRole('button', { name: /keyboard/i }));
    const bridge = screen.getByTestId('keyboard-bridge') as HTMLInputElement;
    expect(document.activeElement).toBe(bridge);
    const before = (inputType: string, data: string | null) => {
      const e = new InputEvent('beforeinput', { inputType, data, cancelable: true, bubbles: true });
      act(() => void bridge.dispatchEvent(e));
      return e;
    };
    expect(before('insertText', 'x').defaultPrevented).toBe(true);
    before('deleteContentBackward', null);
    before('insertLineBreak', null);
    before('insertCompositionText', 'に');
    act(() => void bridge.dispatchEvent(new CompositionEvent('compositionend', { data: '日本', bubbles: true })));
    expect(sent).toEqual([
      { t: 'text', text: 'x' },
      { t: 'key', action: 'down', key: 'Backspace', code: 'Backspace', modifiers: 0 },
      { t: 'key', action: 'up', key: 'Backspace', code: 'Backspace', modifiers: 0 },
      { t: 'key', action: 'down', key: 'Enter', code: 'Enter', text: '\r', modifiers: 0 },
      { t: 'key', action: 'up', key: 'Enter', code: 'Enter', modifiers: 0 },
      { t: 'text', text: '日本' },
    ]);
    expect(bridge.value).toBe('');
  });

  it('closes the socket on unmount', () => {
    const r = setup();
    r.unmount();
    expect(closed).toBe(true);
  });
});
