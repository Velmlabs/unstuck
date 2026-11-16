import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/preact';
import type { ConnectionHandlers } from '../src/connection';
import { App, DRAG_TIP_OFF, DRAG_TIP_ON, type AppProps } from '../src/App';
import { HELP_ITEMS } from '../src/help';

const NOW = 1_700_000_000_000;
let handlers: ConnectionHandlers;
let sent: unknown[];
let closed: boolean;
let connectOpts: { resumeKey?: string; alive?: () => Promise<boolean> } | undefined;
let wakes = 0;
let connects = 0;
let hellos: (string | undefined)[];
let acked: unknown[];
let connectUrl = '';
const connectFn: AppProps['connectFn'] = (url, _token, _codec, h, opts) => {
  connectUrl = url;
  connects++;
  handlers = h;
  connectOpts = opts;
  return {
    send: (m) => void sent.push(m),
    sendHello: (c) => void hellos.push(c),
    close: () => void (closed = true),
    wake: () => void wakes++,
    ack: (f) => void acked.push(f),
  };
};
const KEY = 'A'.repeat(43);
const loc = (hash = `#t=TOK&k=${KEY}`) => ({ hash, pathname: '/s/SESSION', origin: 'http://127.0.0.1:5000' });
const drawFrame = vi.fn();
/** Dispatch a real (jsdom) MouseEvent under a pointer event name; jsdom has no PointerEvent. */
function pointer(el: Element, type: 'pointerdown' | 'pointerup' | 'pointermove', init: MouseEventInit) {
  act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })));
}

/** Taps Start when the page shows it (a link opened for the first time on this device). */
function start() {
  const b = screen.queryByRole('button', { name: 'Start takeover' });
  if (b) fireEvent.click(b);
}
function setup(hash?: string) {
  const r = render(<App location={loc(hash)} connectFn={connectFn} drawFrame={drawFrame} now={() => NOW} />);
  start();
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
  setBox(canvas, 0, 0, 640, 360);
  return canvas;
}
/** The mirror's untransformed box (the viewport around the canvas, which the zoom transform never moves). */
function setBox(canvas: Element, left: number, top: number, width: number, height: number) {
  const viewport = canvas.parentElement!;
  viewport.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
}

beforeEach(() => {
  localStorage.clear();
  sent = [];
  hellos = [];
  acked = [];
  connects = 0;
  closed = false;
  drawFrame.mockClear();
});
afterEach(() => cleanup());

describe('tap to start: link previews and scanners never use a link', () => {
  it('opening the link connects nothing until a person taps Start', () => {
    render(<App location={loc()} connectFn={connectFn} drawFrame={drawFrame} now={() => NOW} />);
    expect(connects).toBe(0);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Someone needs your help in a browser');
    expect(screen.queryByTestId('screen')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start takeover' }));
    expect(connects).toBe(1);
    goLive();
    expect(screen.getByTestId('screen')).toBeTruthy();
  });

  it('an alert shows what the agent needs and where before Start', () => {
    render(<App location={loc()} connectFn={connectFn} drawFrame={drawFrame} now={() => NOW} alert={{ reason: 'Log in to the supplier portal', site: 'portal.example', expiresAt: NOW + 600_000 } as never} />);
    expect(connects).toBe(0);
    expect(screen.getByText('Log in to the supplier portal')).toBeTruthy();
    expect(screen.getByText('portal.example')).toBeTruthy();
  });

  it('the same phone coming back (it holds the resume key) goes straight in', () => {
    localStorage.setItem('unstuck:resume:SESSION', 'k');
    render(<App location={loc()} connectFn={connectFn} drawFrame={drawFrame} now={() => NOW} />);
    expect(connects).toBe(1);
    expect(connectOpts?.resumeKey).toBe('k');
  });
});

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
    start();
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
      start();
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

  describe('before the first frame', () => {
    const connectNoFrame = () =>
      act(() => {
        handlers.onReady({ t: 'ready', reason: 'Solve the CAPTCHA', site: 'shop.example', expiresAt: NOW + 125_000, resumeKey: 'k' });
        handlers.onPhase('live');
      });
    const waiting = () => screen.queryAllByRole('status').find((el) => el.textContent?.includes('Waiting for the page'));

    it('says it is waiting for the page, and after 10 s that the page may still be loading; the first frame removes it', () => {
      vi.useFakeTimers();
      try {
        setup();
        expect(waiting()).toBeUndefined(); // still connecting: the banner says so
        connectNoFrame();
        expect(waiting()!.textContent).toBe('Waiting for the page…');
        act(() => void vi.advanceTimersByTime(9_999));
        expect(waiting()!.textContent).toBe('Waiting for the page…');
        act(() => void vi.advanceTimersByTime(1));
        expect(waiting()!.textContent).toBe("Waiting for the page…The page hasn't sent a picture yet. It may still be loading.");
        act(() => handlers.onFrame({ width: 1280, height: 720, jpeg: new Uint8Array([1]) }));
        expect(waiting()).toBeUndefined();
        expect(screen.queryByText(/hasn't sent a picture/)).toBeNull();
        // A connection drop after that never brings it back.
        act(() => handlers.onPhase('reconnecting'));
        act(() => handlers.onPhase('live'));
        expect(waiting()).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a frame before 10 s means the hint never shows', () => {
      vi.useFakeTimers();
      try {
        setup();
        connectNoFrame();
        act(() => handlers.onFrame({ width: 1280, height: 720, jpeg: new Uint8Array([1]) }));
        act(() => void vi.advanceTimersByTime(20_000));
        expect(screen.queryByText(/hasn't sent a picture/)).toBeNull();
        expect(waiting()).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('draws incoming frames on the canvas', () => {
    setup();
    goLive();
    expect(drawFrame).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), { width: 1280, height: 720, jpeg: new Uint8Array([1]) }, expect.any(Function));
  });

  it('acks each frame once it has been drawn (frame credit), not before', () => {
    setup();
    goLive();
    const f = { width: 1280, height: 720, jpeg: new Uint8Array([2]), seq: 7 };
    act(() => handlers.onFrame(f));
    const call = drawFrame.mock.calls.at(-1)!;
    expect(call[1]).toBe(f);
    expect(acked).toEqual([]);
    call[2](f); // drawn
    expect(acked).toEqual([f]);
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
    setBox(c, 0, 0, 390, 844);
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
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => void canvas.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
  });

  it('sends wheel events', () => {
    setup();
    const canvas = goLive();
    act(() => void canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, clientX: 320, clientY: 180, deltaX: 0, deltaY: 120, cancelable: true })));
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
    act(() => void canvas.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true, clientX: 320, clientY: 180 })));
    expect(sent.at(-1)).toMatchObject({ t: 'mouse', action: 'up', x: 640, y: 360, button: 'left' });
  });

  it('Final I3: an up with no matching down sends nothing', () => {
    setup();
    const canvas = goLive();
    pointer(canvas, 'pointerup', { clientX: 700, clientY: 180, button: 0 });
    act(() => void canvas.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true, clientX: 1, clientY: 1 })));
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

    it('the outline and the typing box follow the mirror when its area changes size (Android resizes the page as the keyboard hides)', () => {
      const observers: ((entries: unknown[]) => void)[] = [];
      vi.stubGlobal('ResizeObserver', class {
        constructor(cb: (entries: unknown[]) => void) {
          observers.push(cb);
        }
        observe() {}
        disconnect() {}
      });
      try {
        const { canvas, bridge } = live();
        tap(canvas, 150, 170);
        act(() => handlers.onFocus?.('otp', otp));
        expect(boxOf(ring()!)).toEqual(['100px', '150px', '200px', '40px']);
        // The keyboard hides: the page grows and the mirror is centred 58 px lower in its area.
        setBox(canvas, 0, 58, 640, 360);
        act(() => observers.forEach((cb) => cb([])));
        expect(boxOf(ring()!)).toEqual(['100px', '208px', '200px', '40px']);
        expect(boxOf(bridge)!.slice(0, 2)).toEqual(['100px', '208px']);
        // The same after a window resize, for browsers without ResizeObserver callbacks on that change.
        setBox(canvas, 0, 0, 640, 360);
        act(() => void window.dispatchEvent(new Event('resize')));
        expect(boxOf(ring()!)).toEqual(['100px', '150px', '200px', '40px']);
      } finally {
        vi.unstubAllGlobals();
      }
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
        const stage = canvas.closest('.stage') as HTMLElement;
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
        const stage = canvas.closest('.stage') as HTMLElement;
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
  const withSearch = (search: string, extra: Partial<AppProps> = {}) => {
    const r = render(<App location={{ ...loc(), search }} connectFn={connectFn} drawFrame={drawFrame} now={() => NOW} {...extra} />);
    start();
    return r;
  };
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  const WARN = "This link wasn't sent by Unstuck alerts. Only continue if you expected it.";

  it('shows the paired-phone page for no_device and never connects', () => {
    render(<App location={{ ...loc(''), search: '?by=k' }} alertError="no_device" connectFn={connectFn} drawFrame={drawFrame} />);
    start();
    expect(screen.getByText('Open this link on the phone you paired')).toBeTruthy();
    expect(screen.getByText(/In-App Browser/)).toBeTruthy();
    expect(screen.getByText(/Settings/)).toBeTruthy();
    expect(connects).toBe(0);
  });

  it('says the phone was paired again or removed for not_for_this_device (this browser has a pairing), and never connects', () => {
    render(<App location={{ ...loc(''), search: '' }} alertError="not_for_this_device" connectFn={connectFn} drawFrame={drawFrame} />);
    start();
    expect(screen.getByText("This phone was paired again or removed, so alerts sent before that can't be opened here.")).toBeTruthy();
    expect(screen.queryByText('Open this link on the phone you paired')).toBeNull();
    expect(connects).toBe(0);
  });

  it('shows the key only after Cloud confirms it sent this alert, with the site from the sealed payload', async () => {
    let answer!: (s: { keyName: string }) => void;
    const sender = vi.fn(() => new Promise<{ keyName: string }>((r) => (answer = r)));
    withSearch('?by=forged', { alert: { reason: 'Solve the CAPTCHA', site: 'news.example.com', sender } });
    expect(screen.queryByText(/From your key/)).toBeNull();
    expect(screen.getByText('Solve the CAPTCHA')).toBeTruthy();
    await act(async () => answer({ keyName: 'crawler-prod' }));
    expect(screen.getByText('From your key crawler-prod · news.example.com')).toBeTruthy();
    goLive();
    // The relay's site never replaces the sealed one in the key line.
    expect(screen.getByText('From your key crawler-prod · news.example.com')).toBeTruthy();
    expect(screen.queryByText(/forged/)).toBeNull();
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('shows the key alone when the sealed payload has no site', async () => {
    withSearch('', { alert: { reason: 'r', site: '', sender: async () => ({ keyName: 'crawler-prod' }) } });
    await flush();
    expect(screen.getByText('From your key crawler-prod')).toBeTruthy();
  });

  it('a 404 (not sent by Unstuck) shows the warning and no key', async () => {
    withSearch('?by=crawler-prod', { alert: { reason: 'r', site: 's', sender: async () => 'not_sent' as const } });
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(WARN);
    expect(screen.queryByText(/From your key/)).toBeNull();
  });

  it('a network error or other answer shows neither label nor warning', async () => {
    withSearch('?by=crawler-prod', { alert: { reason: 'r', site: 's', sender: async () => null } });
    await flush();
    expect(screen.queryByText(/From your key/)).toBeNull();
    expect(screen.queryByText(WARN)).toBeNull();
  });

  it('never renders ?by= from the query string on a plain link', async () => {
    withSearch('?by=crawler-prod');
    await flush();
    goLive();
    expect(screen.queryByText(/From your key/)).toBeNull();
    expect(screen.queryByText(/crawler-prod/)).toBeNull();
  });

  it('cuts a long key name to 64 code points, strips bidi and control characters, and shows markup as plain text', async () => {
    const name = '<b>\u202e' + 'x'.repeat(100);
    const { container } = withSearch('', { alert: { reason: 'r', site: 'a\u200bb.com', sender: async () => ({ keyName: name }) } });
    await flush();
    const p = container.querySelector('.from')!;
    expect(p.textContent).toBe('From your key ' + ('<b>' + 'x'.repeat(100)).slice(0, 64) + ' · ab.com');
    expect(container.querySelector('.from b')).toBeNull();
  });
});

describe('zoom', () => {
  type FingerEvent = 'pointerdown' | 'pointerup' | 'pointermove' | 'pointercancel' | 'lostpointercapture';
  /**
   * A finger (pointerType touch) on the mirror; jsdom has no PointerEvent, so the fields are set on a MouseEvent.
   * Finger 1 is the first finger (isPrimary) unless said otherwise.
   */
  function finger(el: Element, type: FingerEvent, id: number, x: number, y: number, primary = id === 1) {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
    Object.defineProperty(ev, 'pointerType', { value: 'touch' });
    Object.defineProperty(ev, 'pointerId', { value: id });
    Object.defineProperty(ev, 'isPrimary', { value: primary });
    act(() => void el.dispatchEvent(ev));
  }
  let clock = 0;
  /** Time passes: the clock the viewer reads and its timers. */
  const tick = (ms: number) => {
    clock += ms;
    act(() => void vi.advanceTimersByTime(ms));
  };
  /** A finger tap that lasts `ms`, and the time for its release to follow. */
  const fingerTap = (el: Element, x: number, y: number, ms = 80, id = 1, primary = id === 1) => {
    finger(el, 'pointerdown', id, x, y, primary);
    clock += ms;
    finger(el, 'pointerup', id, x, y, primary);
    tick(300);
  };
  beforeEach(() => {
    clock = 1000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const btn = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
  const scaleOf = (c: HTMLCanvasElement) => Number(/scale\(([\d.]+)\)/.exec(c.style.transform)?.[1] ?? 1);
  const mice = () => sent.filter((m) => (m as { t: string }).t === 'mouse') as { action: string; x: number; y: number }[];
  const steps = () => mice().map((m) => [m.action, m.x, m.y]);
  const zoom2x = () => {
    fireEvent.click(btn('Zoom in'));
    fireEvent.click(btn('Zoom in')); // 2× around the centre: 1 CSS px = 1 page px, page (320,180) at the top-left
  };

  it('has labelled zoom in, zoom out and fit buttons next to the scroll buttons; fit resets', () => {
    setup();
    const canvas = goLive();
    const group = screen.getByRole('group', { name: 'Zoom' });
    expect(group.closest('.stage')).toBeTruthy();
    expect(canvas.getAttribute('aria-label')).toContain('Pinch or use + to zoom');
    expect(btn('Zoom out').disabled).toBe(true);
    expect(btn('Fit page to screen').disabled).toBe(true);
    fireEvent.click(btn('Zoom in'));
    expect(scaleOf(canvas)).toBeCloseTo(Math.SQRT2, 3);
    expect(canvas.style.transform).toMatch(/^translate\(/);
    fireEvent.click(btn('Zoom in'));
    expect(scaleOf(canvas)).toBe(2);
    expect(btn('Zoom out').disabled).toBe(false);
    fireEvent.click(btn('Zoom out'));
    expect(scaleOf(canvas)).toBeCloseTo(Math.SQRT2, 3);
    fireEvent.click(btn('Fit page to screen'));
    expect(canvas.style.transform).toBe('');
    expect(btn('Fit page to screen').disabled).toBe(true);
    for (let i = 0; i < 6; i++) fireEvent.click(btn('Zoom in'));
    expect(scaleOf(canvas)).toBe(4);
    expect(btn('Zoom in').disabled).toBe(true);
    expect(sent).toEqual([]); // zooming is the phone's own business: nothing reaches the page
  });

  it('the buttons do nothing before the first frame, and neither zoom nor scroll buttons take focus from the keyboard', () => {
    setup();
    act(() => handlers.onPhase('live'));
    const canvas = screen.getByTestId('screen') as HTMLCanvasElement;
    expect(canvas.hasAttribute('data-framed')).toBe(false);
    fireEvent.click(btn('Zoom in'));
    expect(canvas.style.transform).toBe('');
    for (const name of ['Zoom in', 'Scroll down']) {
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      btn(name).dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
    }
    goLive();
    expect(canvas.hasAttribute('data-framed')).toBe(true); // what end-to-end tests wait for before tapping
  });

  it('a tap while zoomed sends the page point under the finger or the mouse', () => {
    setup();
    const canvas = goLive();
    zoom2x();
    pointer(canvas, 'pointerdown', { clientX: 0, clientY: 0, button: 0 });
    pointer(canvas, 'pointerup', { clientX: 0, clientY: 0, button: 0 });
    fingerTap(canvas, 100, 50);
    expect(steps()).toEqual([
      ['down', 320, 180],
      ['up', 320, 180],
      ['down', 420, 230],
      ['up', 420, 230],
    ]);
  });

  it("a finger tap: the press at release, the release after the finger's real time down, where it pressed", () => {
    setup();
    const canvas = goLive();
    finger(canvas, 'pointerdown', 1, 320, 180);
    expect(mice()).toEqual([]); // could still become a pinch
    clock += 120;
    finger(canvas, 'pointerup', 1, 324, 183);
    expect(steps()).toEqual([['down', 640, 360]]);
    tick(119);
    expect(mice()).toHaveLength(1);
    tick(1);
    expect(steps()).toEqual([
      ['down', 640, 360],
      ['up', 640, 360],
    ]);
    // A very quick tap still lasts 40 ms on the page.
    finger(canvas, 'pointerdown', 1, 100, 100);
    clock += 3;
    finger(canvas, 'pointerup', 1, 100, 100);
    tick(39);
    expect(mice()).toHaveLength(3);
    tick(1);
    expect(mice()).toHaveLength(4);
  });

  it('two quick taps at one spot are two clicks (no double-tap zoom), in order', () => {
    setup();
    const canvas = goLive();
    finger(canvas, 'pointerdown', 1, 160, 90);
    clock += 100;
    finger(canvas, 'pointerup', 1, 160, 90);
    tick(50); // the first release is still on its way when the second tap lands and ends
    finger(canvas, 'pointerdown', 1, 160, 90);
    clock += 30;
    finger(canvas, 'pointerup', 1, 160, 90);
    tick(300);
    expect(mice().map((m) => m.action)).toEqual(['down', 'up', 'down', 'up']);
    expect(canvas.style.transform).toBe('');
  });

  it('a tap on a field opens the keyboard inside the touch handler, before its release reaches the page', () => {
    setup();
    const canvas = goLive();
    act(() => handlers.onFields?.([{ x: 200, y: 300, w: 400, h: 80, kind: 'otp' }]));
    finger(canvas, 'pointerdown', 1, 150, 170);
    clock += 60;
    finger(canvas, 'pointerup', 1, 150, 170);
    const bridge = screen.getByTestId('keyboard-bridge') as HTMLInputElement;
    expect(document.activeElement).toBe(bridge);
    expect(mice().map((m) => m.action)).toEqual(['down']);
    tick(60);
    expect(mice().map((m) => m.action)).toEqual(['down', 'up']);
  });

  it('Drag mode: a finger drag is the press where it landed, then (one tick later) a move where it crossed the slop, then moves', () => {
    setup();
    const canvas = goLive();
    fireEvent.click(btn('Drag mode'));
    finger(canvas, 'pointerdown', 1, 100, 100);
    finger(canvas, 'pointermove', 1, 104, 100); // within the slop: nothing yet
    expect(mice()).toEqual([]);
    finger(canvas, 'pointermove', 1, 130, 100);
    expect(steps()).toEqual([['down', 200, 200]]); // never the press and its first move in the same tick
    finger(canvas, 'pointermove', 1, 140, 100); // throttled
    tick(16);
    finger(canvas, 'pointermove', 1, 160, 100);
    finger(canvas, 'pointerup', 1, 160, 100);
    expect(steps()).toEqual([
      ['down', 200, 200],
      ['move', 260, 200],
      ['move', 320, 200],
      ['up', 320, 200],
    ]);
  });

  it('slider precision: a throttled move is sent when the tick ends, and a release elsewhere moves there first', () => {
    setup();
    const canvas = goLive();
    pointer(canvas, 'pointerdown', { clientX: 320, clientY: 180, button: 0 });
    pointer(canvas, 'pointermove', { clientX: 330, clientY: 180, buttons: 1 });
    pointer(canvas, 'pointermove', { clientX: 335, clientY: 180, buttons: 1 }); // throttled, superseded
    pointer(canvas, 'pointermove', { clientX: 340, clientY: 180, buttons: 1 }); // throttled: the newest
    tick(16);
    pointer(canvas, 'pointerup', { clientX: 340, clientY: 180, button: 0 }); // the page is already there: no extra move
    pointer(canvas, 'pointerdown', { clientX: 340, clientY: 180, button: 0 });
    tick(16);
    pointer(canvas, 'pointermove', { clientX: 350, clientY: 180, buttons: 1 });
    pointer(canvas, 'pointermove', { clientX: 355, clientY: 180, buttons: 1 }); // throttled
    pointer(canvas, 'pointerup', { clientX: 360, clientY: 180, button: 0 });
    tick(50); // the held-back move doesn't follow the release
    expect(steps()).toEqual([
      ['down', 640, 360],
      ['move', 660, 360],
      ['move', 680, 360],
      ['up', 680, 360],
      ['down', 680, 360],
      ['move', 700, 360],
      ['move', 720, 360],
      ['up', 720, 360],
    ]);
  });

  it('a hold-then-drag and a hold while zoomed map through the zoom', () => {
    setup();
    const canvas = goLive();
    zoom2x();
    finger(canvas, 'pointerdown', 1, 0, 0);
    tick(250);
    finger(canvas, 'pointermove', 1, 40, 0);
    tick(16);
    finger(canvas, 'pointerup', 1, 40, 0);
    finger(canvas, 'pointerdown', 1, 100, 100);
    tick(250);
    finger(canvas, 'pointerup', 1, 100, 100);
    expect(steps()).toEqual([
      ['down', 320, 180],
      ['move', 360, 180],
      ['up', 360, 180],
      ['down', 420, 280],
      ['up', 420, 280],
    ]);
  });

  it('a finger held still is pressed after a moment (press-and-hold challenges); a tap in the letterbox sends nothing', () => {
    setup();
    const canvas = goLive();
    finger(canvas, 'pointerdown', 1, 100, 100);
    tick(250);
    expect(mice().map((m) => m.action)).toEqual(['down']);
    finger(canvas, 'pointerup', 1, 100, 100);
    expect(mice().map((m) => m.action)).toEqual(['down', 'up']);
    setBox(canvas, 0, 0, 640, 720); // letterboxed: the page sits between y 180 and 540
    fingerTap(canvas, 100, 20);
    finger(canvas, 'pointerdown', 1, 100, 20);
    tick(300);
    finger(canvas, 'pointermove', 1, 100, 80);
    finger(canvas, 'pointerup', 1, 100, 80);
    expect(mice().map((m) => m.action)).toEqual(['down', 'up']);
  });

  describe('swipe to move, hold to drag', () => {
    const wheels = () => sent.filter((m) => (m as { t: string }).t === 'wheel');

    it('a swipe at fit scrolls the page at the finger, in page px, the content following the finger; no mouse input', () => {
      setup();
      const canvas = goLive(); // 640×360 showing 1280×720: 1 screen px = 2 page px
      finger(canvas, 'pointerdown', 1, 320, 180);
      finger(canvas, 'pointermove', 1, 320, 172); // within the slop: nothing yet
      expect(sent).toEqual([]);
      finger(canvas, 'pointermove', 1, 320, 150); // finger up 30 px from where it landed: the page scrolls down 60
      expect(sent).toEqual([{ t: 'wheel', x: 640, y: 300, dx: 0, dy: 60 }]);
      finger(canvas, 'pointermove', 1, 325, 145); // inside the tick: held back, added up
      finger(canvas, 'pointermove', 1, 330, 140);
      expect(wheels()).toHaveLength(1);
      tick(16);
      expect(wheels().at(-1)).toEqual({ t: 'wheel', x: 660, y: 280, dx: -20, dy: 20 });
      finger(canvas, 'pointermove', 1, 330, 120);
      finger(canvas, 'pointermove', 1, 330, 100); // the tick is still running: both wait
      expect(wheels()).toHaveLength(2);
      finger(canvas, 'pointerup', 1, 330, 100); // the rest goes at the lift
      expect(wheels().at(-1)).toEqual({ t: 'wheel', x: 660, y: 200, dx: 0, dy: 80 });
      tick(300);
      expect(wheels()).toHaveLength(3);
      expect(mice()).toEqual([]);
      // No movement lost: 80 screen px up and 10 right, 160 and 20 page px.
      const sum = wheels().reduce<[number, number]>((a, m) => [a[0] + (m as { dx: number }).dx, a[1] + (m as { dy: number }).dy], [0, 0]);
      expect(sum).toEqual([-20, 160]);
    });

    it('the throttle sends at most one wheel per tick, and stops once the finger rests', () => {
      setup();
      const canvas = goLive();
      finger(canvas, 'pointerdown', 1, 320, 300);
      finger(canvas, 'pointermove', 1, 320, 280);
      finger(canvas, 'pointermove', 1, 320, 270);
      tick(16);
      tick(16); // nothing came during this tick: the throttle goes quiet
      finger(canvas, 'pointermove', 1, 320, 265); // a free tick: sent at once
      expect(wheels().map((m) => (m as { dy: number }).dy)).toEqual([40, 20, 10]);
      finger(canvas, 'pointerup', 1, 320, 265);
      expect(wheels()).toHaveLength(3); // nothing left to send
    });

    it('a short swipe that starts and ends on one spot never clicks it', () => {
      setup();
      const canvas = goLive();
      finger(canvas, 'pointerdown', 1, 100, 100);
      finger(canvas, 'pointermove', 1, 115, 100);
      finger(canvas, 'pointermove', 1, 100, 100);
      clock += 120;
      finger(canvas, 'pointerup', 1, 100, 100);
      tick(300);
      expect(mice()).toEqual([]);
      expect(wheels().map((m) => (m as { dx: number }).dx)).toEqual([-30, 30]);
    });

    it('zoomed in, a swipe pans the view first and scrolls the page with what is left at its edge', () => {
      setup();
      const canvas = goLive();
      zoom2x(); // translate(-320px, -180px): 180 px of room to pan down the page, 1 screen px = 1 page px
      finger(canvas, 'pointerdown', 1, 300, 300);
      finger(canvas, 'pointermove', 1, 300, 200); // finger up 100: the view pans 100, nothing to the page
      expect(canvas.style.transform).toBe('translate(-320px, -280px) scale(2)');
      expect(sent).toEqual([]);
      tick(16);
      finger(canvas, 'pointermove', 1, 300, 100); // 80 more fit in the view, 20 scroll the page
      expect(canvas.style.transform).toBe('translate(-320px, -360px) scale(2)');
      expect(sent).toEqual([{ t: 'wheel', x: 620, y: 460, dx: 0, dy: 20 }]);
      finger(canvas, 'pointerup', 1, 300, 100);
      expect(mice()).toEqual([]);
      expect(wheels()).toHaveLength(1);
    });

    it('a hold then a drag is a mouse drag: the press at the hold, moves as they come, the release where it lifts', () => {
      setup();
      const canvas = goLive();
      finger(canvas, 'pointerdown', 1, 100, 100);
      finger(canvas, 'pointermove', 1, 104, 100); // within the slop
      tick(250);
      expect(steps()).toEqual([['down', 200, 200]]);
      finger(canvas, 'pointermove', 1, 130, 100);
      finger(canvas, 'pointermove', 1, 140, 100); // throttled: sent when the tick ends
      tick(16);
      finger(canvas, 'pointerup', 1, 160, 100);
      expect(steps()).toEqual([
        ['down', 200, 200],
        ['move', 260, 200],
        ['move', 280, 200],
        ['move', 320, 200],
        ['up', 320, 200],
      ]);
      expect(wheels()).toEqual([]);
    });

    it('a second finger during a swipe ends it cleanly (its scroll so far goes) and pinches; nothing else reaches the page', () => {
      setup();
      const canvas = goLive();
      finger(canvas, 'pointerdown', 1, 220, 180);
      finger(canvas, 'pointermove', 1, 220, 150);
      finger(canvas, 'pointermove', 1, 220, 140); // held back by the tick
      finger(canvas, 'pointerdown', 2, 420, 140);
      expect(wheels().map((m) => (m as { dy: number }).dy)).toEqual([60, 20]);
      finger(canvas, 'pointermove', 1, 120, 140);
      finger(canvas, 'pointermove', 2, 520, 140);
      expect(scaleOf(canvas)).toBe(2);
      finger(canvas, 'pointerup', 1, 120, 140);
      finger(canvas, 'pointermove', 2, 500, 100);
      finger(canvas, 'pointerup', 2, 500, 100);
      tick(300);
      expect(wheels()).toHaveLength(2);
      expect(mice()).toEqual([]);
    });

    it('a cancel, a lost lift or the session leaving live ends a swipe; a wheel due after it is dropped when not live', () => {
      setup();
      const canvas = goLive();
      finger(canvas, 'pointerdown', 1, 320, 180);
      finger(canvas, 'pointermove', 1, 320, 150);
      finger(canvas, 'pointermove', 1, 320, 140);
      finger(canvas, 'pointercancel', 1, 320, 140); // the rest goes
      finger(canvas, 'pointermove', 1, 320, 100); // no longer swiping
      expect(wheels().map((m) => (m as { dy: number }).dy)).toEqual([60, 20]);
      // A swipe whose lift was never reported: the next first finger flushes it and starts clean.
      finger(canvas, 'pointerdown', 2, 320, 180, true);
      finger(canvas, 'pointermove', 2, 320, 150);
      finger(canvas, 'pointermove', 2, 320, 145);
      fingerTap(canvas, 100, 100, 80, 3, true);
      expect(wheels().map((m) => (m as { dy: number }).dy)).toEqual([60, 20, 60, 10]);
      expect(mice().map((m) => m.action)).toEqual(['down', 'up']);
      // Not live with a wheel held back by the tick: it is dropped.
      finger(canvas, 'pointerdown', 4, 320, 180, true);
      finger(canvas, 'pointermove', 4, 320, 150);
      finger(canvas, 'pointermove', 4, 320, 140);
      act(() => handlers.onPhase('reconnecting'));
      tick(50);
      expect(wheels()).toHaveLength(5);
    });

    it('leaves no wheel running after unmount', () => {
      const r = setup();
      const canvas = goLive();
      finger(canvas, 'pointerdown', 1, 320, 180);
      finger(canvas, 'pointermove', 1, 320, 150);
      finger(canvas, 'pointermove', 1, 320, 140);
      const before = sent.length;
      r.unmount();
      act(() => void vi.advanceTimersByTime(100));
      expect(sent.length).toBe(before);
    });

    it('a swipe before the first frame or off the page image scrolls nothing it cannot place', () => {
      setup();
      act(() => handlers.onPhase('live'));
      const canvas = screen.getByTestId('screen');
      setBox(canvas, 0, 0, 640, 360);
      finger(canvas, 'pointerdown', 1, 100, 100);
      finger(canvas, 'pointermove', 1, 100, 50);
      finger(canvas, 'pointerup', 1, 100, 50);
      expect(sent).toEqual([]);
    });
  });

  describe('Drag mode toggle', () => {
    it('is off by default, says what a swipe does, and toggles with aria-pressed', () => {
      setup();
      goLive();
      const b = btn('Drag mode');
      const tip = () => document.getElementById(b.getAttribute('aria-describedby')!)!.textContent;
      expect(b.closest('.stage-controls')).toBeTruthy();
      expect(b.getAttribute('aria-pressed')).toBe('false');
      expect(b.hasAttribute('data-active')).toBe(false);
      expect(tip()).toBe(DRAG_TIP_OFF);
      fireEvent.click(b);
      expect(b.getAttribute('aria-pressed')).toBe('true');
      expect(b.hasAttribute('data-active')).toBe(true);
      expect(tip()).toBe(DRAG_TIP_ON);
      fireEvent.click(b);
      expect(b.getAttribute('aria-pressed')).toBe('false');
      expect(sent).toEqual([]);
    });

    it('is off again for a new session, and never stored', () => {
      setup();
      goLive();
      fireEvent.click(btn('Drag mode'));
      expect(btn('Drag mode').getAttribute('aria-pressed')).toBe('true');
      cleanup();
      localStorage.clear();
      setup();
      goLive();
      expect(btn('Drag mode').getAttribute('aria-pressed')).toBe('false');
      for (let i = 0; i < localStorage.length; i++) expect(localStorage.key(i)).not.toMatch(/drag/i);
    });
  });

  describe('help', () => {
    const dialog = () => screen.queryByRole('dialog');
    it('Help opens a dialog listing every gesture and button; focus goes to Close and back to Help', () => {
      setup();
      goLive();
      const help = btn('Help');
      expect(help.closest('.topbar')).toBeTruthy();
      expect(dialog()).toBeNull();
      fireEvent.click(help);
      const d = dialog()!;
      expect(d.getAttribute('aria-modal')).toBe('true');
      expect(d.textContent).toContain('How to use this screen');
      const rows = [...d.querySelectorAll('li')].map((li) => li.querySelector('strong')!.textContent);
      expect(rows).toEqual(HELP_ITEMS.map((i) => i.name));
      expect(rows).toEqual(['Tap', 'Swipe', 'Press and hold, then drag', 'Pinch, Zoom in, Zoom out', 'Scroll up, Scroll down', 'Drag mode', 'Keyboard', "Can't solve", 'Done']);
      for (const li of d.querySelectorAll('li')) expect(li.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(document.activeElement).toBe(btn('Close'));
      act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
      expect(document.activeElement).toBe(btn('Close')); // focus stays in the dialog
      fireEvent.click(btn('Close'));
      expect(dialog()).toBeNull();
      expect(document.activeElement).toBe(btn('Help'));
    });

    it('closes with Esc (not sent to the page) and with a tap outside the card, not inside it', () => {
      setup();
      goLive();
      fireEvent.click(btn('Help'));
      act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })));
      expect(dialog()).toBeNull();
      expect(sent).toEqual([]);
      fireEvent.click(btn('Help'));
      fireEvent.click(dialog()!); // inside the card
      fireEvent.click(dialog()!.querySelector('li')!);
      expect(dialog()).toBeTruthy();
      fireEvent.click(screen.getByTestId('help-backdrop'));
      expect(dialog()).toBeNull();
    });

    it('while open, nothing reaches the page and the session carries on; a press under way ends first', () => {
      setup();
      const canvas = goLive();
      finger(canvas, 'pointerdown', 1, 100, 100);
      tick(250); // a hold: pressed
      fireEvent.click(btn('Help'));
      expect(mice().map((m) => m.action)).toEqual(['down', 'up']);
      fingerTap(canvas, 100, 100);
      finger(canvas, 'pointerdown', 1, 100, 100);
      finger(canvas, 'pointermove', 1, 100, 50);
      finger(canvas, 'pointerup', 1, 100, 50);
      pointer(canvas, 'pointerdown', { clientX: 10, clientY: 10, button: 0 });
      act(() => void canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 320, clientY: 180, deltaY: 50 })));
      act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true })));
      fireEvent.click(btn('Scroll down'));
      fireEvent.click(btn('Zoom in'));
      expect(sent).toHaveLength(2);
      expect(canvas.style.transform).toBe('');
      drawFrame.mockClear();
      act(() => handlers.onFrame({ width: 1280, height: 720, jpeg: new Uint8Array([2]) }));
      expect(drawFrame).toHaveBeenCalledTimes(1); // still live underneath
      expect(screen.getByTestId('countdown')).toBeTruthy();
      fireEvent.click(btn('Close'));
      fingerTap(canvas, 100, 100);
      expect(mice().map((m) => m.action)).toEqual(['down', 'up', 'down', 'up']);
    });
  });

  it('a pinch zooms around its centre, sends nothing to the page, and two fingers moving together pan; a third finger is ignored', () => {
    setup();
    const canvas = goLive();
    finger(canvas, 'pointerdown', 1, 220, 180);
    finger(canvas, 'pointerdown', 2, 420, 180);
    finger(canvas, 'pointermove', 1, 120, 180);
    finger(canvas, 'pointermove', 2, 520, 180); // spread 200 → 400 around (320,180)
    expect(scaleOf(canvas)).toBe(2);
    finger(canvas, 'pointerdown', 3, 10, 10); // a third finger
    finger(canvas, 'pointermove', 3, 600, 300);
    expect(scaleOf(canvas)).toBe(2);
    finger(canvas, 'pointermove', 4, 0, 0); // a finger that never went down
    finger(canvas, 'pointerup', 3, 600, 300);
    finger(canvas, 'pointerup', 1, 120, 180);
    finger(canvas, 'pointermove', 2, 300, 300); // one finger left after a pinch: nothing until it lifts
    finger(canvas, 'pointerup', 2, 300, 300);
    tick(300);
    expect(sent).toEqual([]);
    fingerTap(canvas, 320, 180);
    expect(steps()).toEqual([
      ['down', 640, 360],
      ['up', 640, 360],
    ]);
    // Pan: both fingers 40 px left at the same spread.
    finger(canvas, 'pointerdown', 1, 220, 180);
    finger(canvas, 'pointerdown', 2, 420, 180);
    finger(canvas, 'pointermove', 1, 180, 180);
    finger(canvas, 'pointermove', 2, 380, 180);
    finger(canvas, 'pointercancel', 1, 180, 180);
    finger(canvas, 'pointercancel', 2, 380, 180);
    fingerTap(canvas, 280, 180);
    expect(mice().slice(-1)[0]).toMatchObject({ x: 640, y: 360 });
  });

  it('a second finger after a press has started ends that press first; a cancel after a press releases it', () => {
    setup();
    const canvas = goLive();
    finger(canvas, 'pointerdown', 1, 100, 100);
    tick(300);
    finger(canvas, 'pointerdown', 2, 300, 100);
    expect(mice().map((m) => m.action)).toEqual(['down', 'up']);
    finger(canvas, 'pointermove', 2, 400, 100);
    expect(scaleOf(canvas)).toBeCloseTo(1.5);
    finger(canvas, 'pointerup', 1, 100, 100);
    finger(canvas, 'pointerup', 2, 400, 100);
    expect(mice()).toHaveLength(2);
    // A cancelled finger that was never pressed sends nothing; one that was pressed is released where it was.
    finger(canvas, 'pointerdown', 1, 100, 100);
    finger(canvas, 'pointercancel', 1, 100, 100);
    expect(mice()).toHaveLength(2);
    fireEvent.click(btn('Fit page to screen'));
    finger(canvas, 'pointerdown', 1, 100, 100);
    tick(250);
    finger(canvas, 'pointercancel', 1, 110, 100);
    expect(steps().slice(-3)).toEqual([
      ['down', 200, 200],
      ['move', 220, 200],
      ['up', 220, 200],
    ]);
  });

  it('a lift that never came does not freeze the mirror: the next first finger starts clean', () => {
    setup();
    const canvas = goLive();
    finger(canvas, 'pointerdown', 1, 100, 100); // its lift is never reported
    fingerTap(canvas, 200, 100, 80, 2, true);
    expect(mice().map((m) => m.action)).toEqual(['down', 'up']);
    // A pinch whose second lift was lost.
    finger(canvas, 'pointerdown', 3, 220, 180, true);
    finger(canvas, 'pointerdown', 4, 420, 180, false);
    finger(canvas, 'pointerup', 3, 220, 180, true);
    fingerTap(canvas, 50, 50, 80, 5, true);
    expect(mice().map((m) => m.action)).toEqual(['down', 'up', 'down', 'up']);
    // A press whose lift was lost is released before the new finger's tap.
    finger(canvas, 'pointerdown', 6, 100, 100, true);
    tick(250);
    finger(canvas, 'pointermove', 6, 104, 100);
    fingerTap(canvas, 300, 100, 80, 7, true);
    expect(steps().slice(-3)).toEqual([
      ['up', 208, 200],
      ['down', 600, 200],
      ['up', 600, 200],
    ]);
  });

  it('a stale lift for a finger the mirror never saw sends nothing and does not end another finger’s press', () => {
    setup();
    const canvas = goLive();
    finger(canvas, 'pointerup', 9, 100, 100);
    expect(sent).toEqual([]);
    finger(canvas, 'pointerdown', 1, 100, 100);
    tick(250);
    finger(canvas, 'pointerup', 9, 300, 300);
    expect(mice().map((m) => m.action)).toEqual(['down']);
    finger(canvas, 'pointerup', 1, 100, 100);
    expect(mice().map((m) => m.action)).toEqual(['down', 'up']);
  });

  it('a lost pointer capture, the page being hidden or the session leaving live release a press and forget the fingers', () => {
    setup();
    const canvas = goLive();
    finger(canvas, 'pointerdown', 1, 100, 100);
    tick(250);
    finger(canvas, 'lostpointercapture', 1, 100, 100);
    expect(mice().map((m) => m.action)).toEqual(['down', 'up']);
    finger(canvas, 'lostpointercapture', 1, 100, 100); // already forgotten: nothing
    expect(mice()).toHaveLength(2);

    finger(canvas, 'pointerdown', 1, 100, 100);
    tick(250);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      act(() => void document.dispatchEvent(new Event('visibilitychange')));
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    }
    expect(mice().map((m) => m.action)).toEqual(['down', 'up', 'down', 'up']);
    act(() => void document.dispatchEvent(new Event('visibilitychange'))); // visible again: nothing to release
    expect(mice()).toHaveLength(4);

    finger(canvas, 'pointerdown', 1, 100, 100);
    tick(250);
    act(() => handlers.onPhase('reconnecting'));
    expect(mice().map((m) => m.action)).toEqual(['down', 'up', 'down', 'up', 'down', 'up']);
  });

  it('nothing is pressed for a finger once the session is not live: no hold, no tap, no delayed release', () => {
    setup();
    const canvas = goLive();
    finger(canvas, 'pointerdown', 1, 100, 100);
    act(() => handlers.onPhase('reconnecting'));
    tick(300);
    finger(canvas, 'pointerup', 1, 100, 100);
    expect(sent).toEqual([]);
    act(() => handlers.onPhase('live'));
    // A tap whose release is due after the session dropped: still released, like any press.
    finger(canvas, 'pointerdown', 1, 100, 100);
    clock += 100;
    finger(canvas, 'pointerup', 1, 100, 100);
    act(() => handlers.onPhase('reconnecting'));
    tick(300);
    expect(mice().map((m) => m.action)).toEqual(['down', 'up']);
  });

  describe("a tap's release still on its way goes before anything else", () => {
    const tapNoWait = (canvas: Element) => {
      finger(canvas, 'pointerdown', 1, 100, 100);
      clock += 100;
      finger(canvas, 'pointerup', 1, 100, 100);
    };
    const kinds = () => sent.map((m) => { const x = m as { t: string; action?: string }; return x.action ? `${x.t}:${x.action}` : x.t; });

    it('Done', () => {
      setup();
      const canvas = goLive();
      tapNoWait(canvas);
      fireEvent.click(btn('Done'));
      expect(kinds()).toEqual(['mouse:down', 'mouse:up', 'done']);
      tick(300);
      expect(kinds()).toHaveLength(3);
    });

    it("Can't solve", () => {
      setup();
      const canvas = goLive();
      tapNoWait(canvas);
      fireEvent.click(btn("Can't solve"));
      expect(kinds()).toEqual(['mouse:down', 'mouse:up']);
      expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('a key or text typed on the page or into the keyboard bridge', () => {
      setup();
      const canvas = goLive();
      tapNoWait(canvas);
      act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true })));
      expect(kinds()).toEqual(['mouse:down', 'mouse:up', 'key:down']);
      tapNoWait(canvas);
      const bridge = screen.getByTestId('keyboard-bridge') as HTMLInputElement;
      act(() => void bridge.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'é', bubbles: true, cancelable: true })));
      expect(kinds().slice(-3)).toEqual(['mouse:down', 'mouse:up', 'text']);
    });
  });

  it('a mouse press is released even if the session stopped being live before the button came up', () => {
    setup();
    const canvas = goLive();
    pointer(canvas, 'pointerdown', { clientX: 100, clientY: 100, button: 0 });
    act(() => handlers.onPhase('reconnecting'));
    pointer(canvas, 'pointerup', { clientX: 100, clientY: 100, button: 0 });
    expect(mice().map((m) => m.action)).toEqual(['down', 'up']);
  });

  it('leaves nothing running after unmount: a held finger, a tap release', () => {
    const r = setup();
    const canvas = goLive();
    finger(canvas, 'pointerdown', 1, 100, 100);
    clock += 100;
    finger(canvas, 'pointerup', 1, 100, 100); // its release is due in 100 ms
    finger(canvas, 'pointerdown', 2, 300, 100, true); // held back
    finger(canvas, 'pointerup', 2, 300, 100); // a tap: the first release goes first, then this press; release due in 40 ms
    expect(mice().map((m) => m.action)).toEqual(['down', 'up', 'down']);
    finger(canvas, 'pointerdown', 3, 100, 100, true); // held: a hold due in 250 ms
    const before = sent.length;
    r.unmount();
    act(() => void vi.advanceTimersByTime(1000));
    expect(sent.length).toBe(before); // neither the tap's release nor the hold fired after the mirror went
  });

  it('places the keyboard bridge and the outline over a field while zoomed, and follows the zoom', () => {
    setup();
    const canvas = goLive();
    const field = { x: 500, y: 300, w: 200, h: 60, kind: 'email' as const };
    act(() => handlers.onFields?.([field]));
    zoom2x(); // the field at 180,120
    fingerTap(canvas, 200, 140);
    const bridge = screen.getByTestId('keyboard-bridge') as HTMLInputElement;
    expect(document.activeElement).toBe(bridge);
    expect([bridge.style.left, bridge.style.top, bridge.style.width, bridge.style.height]).toEqual(['180px', '120px', '200px', '60px']);
    const ring = screen.getByTestId('focus-ring') as HTMLElement;
    expect([ring.style.left, ring.style.top]).toEqual(['180px', '120px']);
    fireEvent.click(btn('Fit page to screen'));
    expect([bridge.style.left, bridge.style.top, bridge.style.width, bridge.style.height]).toEqual(['250px', '150px', '100px', '32px']);
    expect(document.activeElement).toBe(bridge);
    // Focus moves to a field that is panned off the mirror: no outline over the bars, the typing box stays on the mirror.
    zoom2x();
    act(() => handlers.onFocus?.('text', { x: 0, y: 0, w: 200, h: 60, kind: 'text' }));
    expect(screen.queryByTestId('focus-ring')).toBeNull();
    expect([bridge.style.left, bridge.style.top, bridge.style.width, bridge.style.height]).toEqual(['0px', '0px', '200px', '60px']);
    // Partly on it: the outline is cut at the mirror's edge.
    act(() => handlers.onFocus?.('text', { x: 300, y: 160, w: 100, h: 60, kind: 'text' }));
    const cut = screen.getByTestId('focus-ring') as HTMLElement;
    expect([cut.style.left, cut.style.top, cut.style.width, cut.style.height]).toEqual(['0px', '0px', '80px', '40px']);
  });

  it('when zoomed, the page pans out from under the buttons in the bottom-right corner', () => {
    setup();
    const canvas = goLive();
    const controls = btn('Zoom in').closest('.stage-controls') as HTMLElement;
    controls.getBoundingClientRect = () => ({ left: 584, top: 100, width: 44, height: 248, right: 628, bottom: 348, x: 584, y: 100, toJSON: () => ({}) });
    zoom2x();
    // Two fingers pan far up and left: the page's right edge stops 56 px (the column and its margin) short of the
    // mirror's, and its bottom edge 260 px short, so the corner under the buttons can be brought out.
    finger(canvas, 'pointerdown', 1, 220, 180);
    finger(canvas, 'pointerdown', 2, 420, 180);
    finger(canvas, 'pointermove', 1, -280, -320);
    finger(canvas, 'pointermove', 2, -80, -320);
    expect(canvas.style.transform).toBe('translate(-696px, -620px) scale(2)');
    finger(canvas, 'pointerup', 1, -280, -320);
    finger(canvas, 'pointerup', 2, -80, -320);
    fingerTap(canvas, 583, 99); // just left of and above the buttons: the page's bottom-right corner
    expect(mice().slice(-1)[0]).toMatchObject({ x: 1279, y: 719 });
  });

  it('the scroll buttons scroll the part of the page on screen, by a share of what is visible', () => {
    setup();
    const canvas = goLive();
    zoom2x();
    expect(scaleOf(canvas)).toBe(2);
    fireEvent.click(btn('Scroll down'));
    expect(sent).toEqual([{ t: 'wheel', x: 640, y: 360, dx: 0, dy: 216 }]);
  });

  it('resets to fit on a very different page size, keeps the zoom on normal frames', () => {
    setup();
    const canvas = goLive();
    zoom2x();
    act(() => handlers.onFrame({ width: 1280, height: 720, jpeg: new Uint8Array([1]) }));
    expect(scaleOf(canvas)).toBe(2);
    act(() => handlers.onFrame({ width: 1265, height: 720, jpeg: new Uint8Array([1]) })); // a scrollbar appeared
    expect(scaleOf(canvas)).toBe(2);
    act(() => handlers.onFrame({ width: 500, height: 600, jpeg: new Uint8Array([1]) })); // a popup
    expect(canvas.style.transform).toBe('');
    expect(btn('Fit page to screen').disabled).toBe(true);
  });

  it('keeps the zoom in range when the mirror resizes (a phone rotates)', () => {
    setup();
    const canvas = goLive();
    zoom2x();
    expect(canvas.style.transform).toBe('translate(-320px, -180px) scale(2)');
    setBox(canvas, 0, 0, 160, 90);
    act(() => void window.dispatchEvent(new Event('resize')));
    // The pan from the bigger box would show black beyond the page's right and bottom edges: pulled back.
    expect(canvas.style.transform).toBe('translate(-160px, -90px) scale(2)');
  });

  it('ctrl + wheel (a trackpad pinch on a computer) zooms; a plain wheel still scrolls the page at the zoomed point', () => {
    setup();
    const canvas = goLive();
    act(() => void canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 320, clientY: 180, deltaY: -100, ctrlKey: true })));
    expect(scaleOf(canvas)).toBeCloseTo(Math.E, 2);
    expect(sent).toEqual([]);
    act(() => void canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 320, clientY: 180, deltaY: 50 })));
    expect(sent).toEqual([{ t: 'wheel', x: 640, y: 360, dx: 0, dy: 50 }]);
  });

  it("Safari's own page pinch is blocked while the mirror is on screen, and not after", () => {
    const r = setup();
    goLive();
    const g = new Event('gesturestart', { cancelable: true });
    document.dispatchEvent(g);
    expect(g.defaultPrevented).toBe(true);
    r.unmount();
    const after = new Event('gesturechange', { cancelable: true });
    document.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('animates button zooms unless the person prefers reduced motion', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => void frames.splice(0));
    let reduce = false;
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') && reduce }));
    setup();
    const canvas = goLive();
    zoom2x(); // a second press while animating builds on where the first is going
    expect(canvas.style.transform).toBe('');
    clock += 90;
    act(() => frames.shift()!(clock));
    const mid = scaleOf(canvas);
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(2);
    clock += 200;
    act(() => frames.shift()!(clock));
    expect(scaleOf(canvas)).toBe(2);
    expect(frames).toHaveLength(0);
    // A finger landing mid-animation stops it where it is.
    fireEvent.click(btn('Fit page to screen'));
    finger(canvas, 'pointerdown', 1, 10, 10);
    finger(canvas, 'pointercancel', 1, 10, 10);
    expect(frames).toHaveLength(0);
    expect(scaleOf(canvas)).toBe(2);
    reduce = true;
    fireEvent.click(btn('Fit page to screen'));
    expect(canvas.style.transform).toBe('');
  });
});
