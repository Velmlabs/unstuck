import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/preact';
import type { ConnectionHandlers } from '../src/connection';
import { App, type AppProps } from '../src/App';

const NOW = 1_700_000_000_000;
let handlers: ConnectionHandlers;
let sent: unknown[];
let closed: boolean;
let connectOpts: { resumeKey?: string; alive?: () => Promise<boolean> } | undefined;
let wakes = 0;
let connects = 0;
let hellos: (string | undefined)[];
let connectUrl = '';
const connectFn: AppProps['connectFn'] = (url, _token, _codec, h, opts) => {
  connectUrl = url;
  connects++;
  handlers = h;
  connectOpts = opts;
  return { send: (m) => void sent.push(m), sendHello: (c) => void hellos.push(c), close: () => void (closed = true), wake: () => void wakes++ };
};
const KEY = 'A'.repeat(43);
const loc = (hash = `#t=TOK&k=${KEY}`) => ({ hash, pathname: '/s/SESSION', origin: 'http://127.0.0.1:5000' });
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
  localStorage.clear();
  sent = [];
  hellos = [];
  connects = 0;
  closed = false;
  drawFrame.mockClear();
});
afterEach(() => cleanup());

describe('the link secret kept for reloads', () => {
  it('is dropped from this tab when the takeover ends', () => {
    sessionStorage.setItem('unstuck:link:SESSION', '#t=TOK');
    setup();
    goLive();
    act(() => handlers.onState('resolved'));
    expect(sessionStorage.getItem('unstuck:link:SESSION')).toBeNull();
  });
  it('is dropped on an error that ends this link for good (used, expired, closed, invalid)', () => {
    for (const code of ['token_used', 'expired', 'session_closed', 'token_invalid'] as const) {
      sessionStorage.setItem('unstuck:link:SESSION', '#t=TOK');
      setup();
      act(() => handlers.onError(code, 'm'));
      expect(sessionStorage.getItem('unstuck:link:SESSION'), code).toBeNull();
      cleanup();
    }
  });
});

describe('a viewer served from its own origin', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('connects to the relay named in ?r= and asks it whether the session still exists', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<App location={{ hash: `#t=TOK&k=${KEY}`, pathname: '/v/1.2.3/s/SESSION', origin: 'https://view.unstuck.sh', search: '?r=wss%3A%2F%2Frelay.unstuck.sh' }} connectFn={connectFn} drawFrame={drawFrame} now={() => NOW} />);
    expect(connectUrl).toBe('wss://relay.unstuck.sh/ws/SESSION');
    await connectOpts!.alive!();
    expect(fetchMock).toHaveBeenCalledWith('https://relay.unstuck.sh/s/SESSION', { method: 'HEAD', cache: 'no-store' });
  });
});

describe('coming back to the page', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reconnects at once when the page is visible again or the network returns', () => {
    setup();
    goLive();
    wakes = 0;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(wakes).toBe(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    act(() => void window.dispatchEvent(new Event('online')));
    act(() => void window.dispatchEvent(new Event('pageshow')));
    expect(wakes).toBe(3);
  });
  it('asks the relay whether the session still exists with a HEAD of its own page', async () => {
    const fetchMock = vi.fn(async () => ({ status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    setup();
    expect(await connectOpts!.alive!()).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:5000/s/SESSION', { method: 'HEAD', cache: 'no-store' });
    fetchMock.mockResolvedValueOnce({ status: 200 });
    expect(await connectOpts!.alive!()).toBe(true);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await connectOpts!.alive!()).toBe(true); // can't tell: keep trying
  });
  it('a session that ended while the page was away says so instead of "Reconnecting"', () => {
    setup();
    goLive();
    act(() => handlers.onPhase('ended'));
    expect(screen.getByText('This check has ended')).toBeTruthy();
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
  });
  it('a lost connection says how long there is to come back', () => {
    setup();
    goLive();
    act(() => handlers.onPhase('closed'));
    expect(screen.getByText(/within 5 minutes/)).toBeTruthy();
  });
});

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
    // Nothing typed stays in the viewer: only the reserve of invisible characters.
    expect([...bridge.value].every((c) => c === '\u200b')).toBe(true);
  });

  it('Final I1: remembers the resumeKey for this session and offers it on the next load', () => {
    const first = setup();
    goLive();
    expect(localStorage.getItem('unstuck:resume:SESSION')).toBe('k');
    first.unmount();
    setup();
    expect(connectOpts?.resumeKey).toBe('k');
  });

  it('Final I1: forgets the resumeKey when the takeover ends', () => {
    setup();
    goLive();
    act(() => handlers.onState('resolved'));
    expect(localStorage.getItem('unstuck:resume:SESSION')).toBeNull();
  });

  it('Final I1: survives storage that throws (private mode)', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    setup();
    goLive();
    expect(connectOpts?.resumeKey).toBeUndefined();
    get.mockRestore();
    set.mockRestore();
  });

  it('Final I1: the connection-lost screen tells the human how to resume', () => {
    setup();
    act(() => handlers.onPhase('closed'));
    expect(screen.getByText(/reopen the link on this device within 5 minutes/i)).toBeTruthy();
  });

  it('Final I3: releasing a drag in the letterbox still releases the button, clamped to the page edge', () => {
    setup();
    const canvas = goLive();
    pointer(canvas, 'pointerdown', { clientX: 320, clientY: 180, button: 0 });
    pointer(canvas, 'pointerup', { clientX: 700, clientY: 180, button: 0 });
    expect(sent.at(-1)).toEqual({ t: 'mouse', action: 'up', x: 1280, y: 360, button: 'left', clickCount: 1, modifiers: 0 });
  });

  it('Final I3: a cancelled pointer releases the pressed button', () => {
    setup();
    const canvas = goLive();
    pointer(canvas, 'pointerdown', { clientX: 320, clientY: 180, button: 0 });
    act(() => void canvas.dispatchEvent(new MouseEvent('pointercancel', { clientX: 320, clientY: 180 })));
    expect(sent.at(-1)).toMatchObject({ t: 'mouse', action: 'up', x: 640, y: 360, button: 'left' });
  });

  it('Final I3: an up with no matching down sends nothing', () => {
    setup();
    const canvas = goLive();
    pointer(canvas, 'pointerup', { clientX: 700, clientY: 180, button: 0 });
    act(() => void canvas.dispatchEvent(new MouseEvent('pointercancel', { clientX: 1, clientY: 1 })));
    expect(sent).toEqual([]);
  });

  it('Final I5: scroll buttons scroll the agent page from a phone', () => {
    setup();
    goLive();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Scroll up' }));
    expect(sent).toEqual([
      { t: 'wheel', x: 640, y: 360, dx: 0, dy: 432 },
      { t: 'wheel', x: 640, y: 360, dx: 0, dy: -432 },
    ]);
  });

  it('Final I5: scroll buttons do nothing before the first frame', () => {
    setup();
    act(() => handlers.onPhase('live'));
    fireEvent.click(screen.getByRole('button', { name: 'Scroll down' }));
    expect(sent).toEqual([]);
  });

  it('closes the socket on unmount', () => {
    const r = setup();
    r.unmount();
    expect(closed).toBe(true);
  });
});

describe('incomplete links and the six-digit code', () => {
  it('Review Focus 2: a link without the key says it is incomplete and opens no socket', () => {
    setup('#t=TOK');
    expect(screen.getByText('This link is incomplete. Copy the whole link and open it again.')).toBeTruthy();
    expect(connects).toBe(0);
  });

  it('asks for the code, sends it with hello, and says when it is wrong', () => {
    setup();
    act(() => handlers.onCodeRequest!(false));
    const input = screen.getByLabelText('Enter the 6-digit code') as HTMLInputElement;
    expect(input.getAttribute('inputmode')).toBe('numeric');
    expect(input.getAttribute('autocomplete')).toBe('one-time-code');
    fireEvent.input(input, { target: { value: '123456' } });
    fireEvent.submit(input.closest('form')!);
    expect(hellos).toEqual(['123456']);
    act(() => handlers.onCodeRequest!(true));
    expect(screen.getByText('That code is not right.')).toBeTruthy();
  });

  it('the code prompt goes away once the session is ready', () => {
    setup();
    act(() => handlers.onCodeRequest!(false));
    goLive();
    expect(screen.queryByLabelText('Enter the 6-digit code')).toBeNull();
  });

  describe('native typing', () => {
    const otp = { x: 200, y: 300, w: 400, h: 80, kind: 'otp' as const }; // page px; on the 640×360 canvas: 100,150 200×40
    const text = { x: 200, y: 500, w: 400, h: 80, kind: 'text' as const };
    const live = () => {
      setup();
      const canvas = goLive();
      act(() => handlers.onFields?.([otp, text]));
      return { canvas, bridge: screen.getByTestId('keyboard-bridge') as HTMLInputElement };
    };
    const tap = (canvas: Element, x: number, y: number, moveTo?: { x: number; y: number }) => {
      pointer(canvas, 'pointerdown', { clientX: x, clientY: y, button: 0 });
      const end = moveTo ?? { x, y };
      pointer(canvas, 'pointerup', { clientX: end.x, clientY: end.y, button: 0 });
    };

    it('a tap on a code field opens the number pad on release, over the field, and still taps the page', () => {
      const { canvas, bridge } = live();
      tap(canvas, 150, 170);
      expect(document.activeElement).toBe(bridge);
      expect(bridge.inputMode).toBe('numeric');
      expect(bridge.getAttribute('autocomplete')).toBe('one-time-code');
      expect([bridge.style.left, bridge.style.top, bridge.style.width, bridge.style.height]).toEqual(['100px', '150px', '200px', '40px']);
      expect(sent.filter((m) => (m as { t: string }).t === 'mouse').map((m) => (m as { action: string }).action)).toEqual(['down', 'up']);
    });

    it('a drag that starts on a field does not open the keyboard; a tap outside fields closes it', () => {
      const { canvas, bridge } = live();
      tap(canvas, 150, 170, { x: 150, y: 190 });
      expect(document.activeElement).not.toBe(bridge);
      tap(canvas, 150, 170);
      expect(document.activeElement).toBe(bridge);
      tap(canvas, 20, 20);
      expect(document.activeElement).not.toBe(bridge);
    });

    it('focus null after a mapped tap closes the keyboard', () => {
      const { canvas, bridge } = live();
      tap(canvas, 150, 170);
      act(() => handlers.onFocus?.(null));
      expect(document.activeElement).not.toBe(bridge);
    });

    it('a field the map missed shows a "Type here" chip that opens the keyboard; focus null hides it', () => {
      const { bridge } = live();
      act(() => handlers.onFocus?.('email'));
      const chip = screen.getByRole('button', { name: /type here/i });
      fireEvent.click(chip);
      expect(document.activeElement).toBe(bridge);
      expect(bridge.inputMode).toBe('email');
      expect(screen.queryByRole('button', { name: /type here/i })).toBeNull();
      act(() => (bridge.blur(), handlers.onFocus?.('text')));
      expect(screen.getByRole('button', { name: /type here/i })).toBeTruthy();
      act(() => handlers.onFocus?.(null));
      expect(screen.queryByRole('button', { name: /type here/i })).toBeNull();
    });

    it('without a field map the Keyboard button still opens the bridge, over the bottom of the mirror', () => {
      setup();
      goLive();
      const bridge = screen.getByTestId('keyboard-bridge') as HTMLInputElement;
      fireEvent.click(screen.getByRole('button', { name: /^keyboard$/i }));
      expect(document.activeElement).toBe(bridge);
      expect(bridge.inputMode).toBe('text');
      expect([bridge.style.top, bridge.style.height]).toEqual(['316px', '44px']);
    });

    it('a paste into the bridge is sent once', () => {
      const { canvas, bridge } = live();
      tap(canvas, 150, 270);
      sent = [];
      const data = { getData: () => 'hello there' };
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: data });
      act(() => void bridge.dispatchEvent(paste));
      const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data: null });
      Object.defineProperty(e, 'dataTransfer', { value: data });
      act(() => void bridge.dispatchEvent(e));
      expect(sent).toEqual([{ t: 'text', text: 'hello there' }]);
    });

    const ring = () => document.querySelector('[data-testid="focus-ring"]') as HTMLElement | null;
    const boxOf = (el: HTMLElement | null) => el && [el.style.left, el.style.top, el.style.width, el.style.height];

    it('a green outline marks the field being typed into, on the mirror', () => {
      const { canvas } = live();
      expect(ring()).toBeNull();
      tap(canvas, 150, 170);
      expect(boxOf(ring())).toEqual(['100px', '150px', '200px', '40px']);
    });

    it('the outline fits a small field exactly, while the typing box keeps the size iOS needs', () => {
      setup();
      const canvas = goLive();
      const box = { x: 100, y: 100, w: 44, h: 52, kind: 'numeric' as const }; // on the 640×360 canvas: 50,50 22×26
      act(() => handlers.onFields?.([box]));
      tap(canvas, 60, 60);
      expect(boxOf(ring())).toEqual(['50px', '50px', '22px', '26px']);
      const bridge = screen.getByTestId('keyboard-bridge') as HTMLInputElement;
      expect([bridge.style.width, bridge.style.height]).toEqual(['44px', '32px']);
    });

    it('the outline (and the typing box) follow the page when it moves focus to another field', () => {
      const { canvas, bridge } = live();
      tap(canvas, 150, 170);
      act(() => handlers.onFocus?.('otp', otp)); // the report for the tap: same field
      act(() => handlers.onFocus?.('text', text)); // typing moved focus to the next field
      expect(boxOf(ring())).toEqual(['100px', '250px', '200px', '40px']);
      expect(boxOf(bridge)).toEqual(['100px', '250px', '200px', '40px']);
      expect(document.activeElement).toBe(bridge);
    });

    it('no outline once the keyboard closes; the Keyboard button shows one only when the page reports a field', () => {
      const { canvas, bridge } = live();
      tap(canvas, 150, 170);
      act(() => bridge.blur());
      expect(ring()).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /^keyboard$/i }));
      expect(ring()).toBeNull();
      act(() => handlers.onFocus?.('text', text));
      expect(boxOf(ring())).toEqual(['100px', '250px', '200px', '40px']);
    });

    it('typing counts as an input that gets a focus report, so a report for a key press is not taken for a tap', () => {
      const { canvas, bridge } = live();
      tap(canvas, 150, 170);
      act(() => void bridge.dispatchEvent(new KeyboardEvent('keydown', { key: '4', code: 'Digit4', bubbles: true, cancelable: true })));
      act(() => handlers.onFocus?.(null)); // the late report for the tap
      expect(document.activeElement).toBe(bridge); // the key press's report is still to come
      act(() => handlers.onFocus?.('otp', otp));
      expect(document.activeElement).toBe(bridge);
    });

    it('Final: without a field map, a tap on the mirror keeps the keyboard opened with the Keyboard button', () => {
      setup();
      const canvas = goLive();
      const bridge = screen.getByTestId('keyboard-bridge') as HTMLInputElement;
      fireEvent.click(screen.getByRole('button', { name: /^keyboard$/i }));
      tap(canvas, 150, 170);
      expect(document.activeElement).toBe(bridge);
    });

    it('Final: a late "nothing focused" report for an earlier tap does not close the keyboard of a newer tap', () => {
      const { canvas, bridge } = live();
      tap(canvas, 20, 20); // a button on the page
      tap(canvas, 150, 170); // then the code field
      act(() => handlers.onFocus?.(null)); // the report for the first tap arrives late
      expect(document.activeElement).toBe(bridge);
      act(() => handlers.onFocus?.('otp')); // the report for the second tap
      expect(document.activeElement).toBe(bridge);
      expect(screen.queryByRole('button', { name: /type here/i })).toBeNull();
    });

    const withViewport = (height: number, fn: (vv: { height: number; offsetTop: number }, fire: () => void) => void) => {
      const listeners: Record<string, () => void> = {};
      const vv = { height, offsetTop: 0, addEventListener: (t: string, f: () => void) => (listeners[t] = f), removeEventListener: () => {} };
      Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
      try {
        fn(vv, () => act(() => listeners.resize?.()));
      } finally {
        Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
      }
    };

    it('Final: the Keyboard button and the chip never lift the mirror (there is no field to keep in view)', () => {
      withViewport(800, (vv, fire) => {
        setup();
        const canvas = goLive();
        fireEvent.click(screen.getByRole('button', { name: /^keyboard$/i }));
        vv.height = 120;
        fire();
        expect((canvas.parentElement as HTMLElement).style.transform).toBe('');
      });
    });

    it('Final: tapping a lower field while the keyboard is already open lifts the mirror for that field at once', () => {
      withViewport(800, (vv, fire) => {
        const { canvas } = live();
        tap(canvas, 150, 170);
        vv.height = 220;
        fire();
        const stage = canvas.parentElement as HTMLElement;
        const first = Number(/-(\d+)px/.exec(stage.style.transform)?.[1] ?? 0);
        tap(canvas, 150, 270); // the lower text field: no resize event this time
        const second = Number(/-(\d+)px/.exec(stage.style.transform)?.[1] ?? 0);
        expect(second).toBeGreaterThan(first);
      });
    });

    it('keeps the field in view above the keyboard, and lets go when the keyboard closes', () => {
      const listeners: Record<string, () => void> = {};
      const vv = { height: 800, addEventListener: (t: string, f: () => void) => (listeners[t] = f), removeEventListener: () => {} };
      Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
      try {
        const { canvas, bridge } = live();
        tap(canvas, 150, 170);
        const stage = canvas.parentElement as HTMLElement;
        vv.height = 120;
        act(() => listeners.resize?.());
        expect(stage.style.transform).toMatch(/^translateY\(-\d+px\)$/);
        act(() => bridge.blur());
        act(() => listeners.resize?.());
        expect(stage.style.transform).toBe('');
      } finally {
        Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
      }
    });
  });
});


describe('sealed alert links', () => {
  const withSearch = (search: string, extra: Partial<AppProps> = {}) =>
    render(<App location={{ ...loc(), search }} connectFn={connectFn} drawFrame={drawFrame} now={() => NOW} {...extra} />);

  it.each(['no_device', 'not_for_this_device'] as const)('shows the paired-phone page for %s and never connects', (alertError) => {
    render(<App location={{ ...loc(''), search: '?by=k' }} alertError={alertError} connectFn={connectFn} drawFrame={drawFrame} />);
    expect(screen.getByText('Open this link on the phone you paired')).toBeTruthy();
    expect(screen.getByText(/In-App Browser/)).toBeTruthy();
    expect(screen.getByText(/Settings/)).toBeTruthy();
    expect(connects).toBe(0);
  });

  it('shows the key and site while waiting (from the sealed payload) and when live', () => {
    withSearch('?by=crawler-prod', { alert: { reason: 'Solve the CAPTCHA', site: 'news.example.com' } });
    expect(screen.getByText('From your key crawler-prod · news.example.com')).toBeTruthy();
    expect(screen.getByText('Solve the CAPTCHA')).toBeTruthy();
    goLive();
    expect(screen.getByText('From your key crawler-prod · shop.example')).toBeTruthy();
  });

  it('shows the key alone when no site is known yet', () => {
    withSearch('?by=crawler-prod');
    expect(screen.getByText('From your key crawler-prod')).toBeTruthy();
  });

  it('shows nothing about a key without ?by=', () => {
    withSearch('');
    expect(screen.queryByText(/From your key/)).toBeNull();
  });

  it('cuts a long key name to 64 characters and shows markup as plain text', () => {
    const by = '<b>' + 'x'.repeat(100);
    const { container } = withSearch(`?by=${encodeURIComponent(by)}`);
    const p = container.querySelector('.from')!;
    expect(p.textContent).toBe('From your key ' + by.slice(0, 64));
    expect(container.querySelector('.from b')).toBeNull();
  });
});
