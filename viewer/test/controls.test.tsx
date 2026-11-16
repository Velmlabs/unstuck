import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/preact';
import type { ConnectionHandlers } from '../src/connection';
import { App, type AppProps } from '../src/App';
import { HINT_MOUSE, HINT_MS, HINT_SEEN_KEY, HINT_TOUCH, HOVER_MS, LONG_PRESS_MS, TOUCH_TIP_MS, TipButton, useTips } from '../src/tips';

const NOW = 1_700_000_000_000;
let handlers: ConnectionHandlers;
let sent: { t: string; key?: string }[];
const connectFn: AppProps['connectFn'] = (_url, _token, _codec, h) => {
  handlers = h;
  return { send: (m) => void sent.push(m as never), sendHello: () => {}, close: () => {}, wake: () => {}, ack: () => {} };
};
const KEY = 'A'.repeat(43);

function live() {
  const r = render(<App location={{ hash: `#t=TOK&k=${KEY}`, pathname: '/s/SESSION', origin: 'http://127.0.0.1:5000' }} connectFn={connectFn} drawFrame={vi.fn()} now={() => NOW} />);
  const start = screen.queryByRole('button', { name: 'Start takeover' });
  if (start) fireEvent.click(start); // a second mount on this device goes straight back in (resume key)
  act(() => {
    handlers.onReady({ t: 'ready', reason: 'Solve it', site: 'shop.example', expiresAt: NOW + 60_000, resumeKey: 'k' });
    handlers.onPhase('live');
    handlers.onFrame({ width: 1280, height: 720, jpeg: new Uint8Array([1]) });
  });
  return r;
}

/** A pointer event (jsdom has no PointerEvent: the fields are set on a MouseEvent). */
function ptr(el: Element, type: string, pointerType: 'touch' | 'mouse' | 'pen', x = 10, y = 10) {
  const ev = new MouseEvent(type, { bubbles: !type.endsWith('enter') && !type.endsWith('leave'), cancelable: true, clientX: x, clientY: y });
  Object.defineProperty(ev, 'pointerType', { value: pointerType });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  act(() => void el.dispatchEvent(ev));
  return ev;
}
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const btn = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const anchor = (name: string) => btn(name).parentElement!;
const tipOf = (b: Element) => document.getElementById(b.getAttribute('aria-describedby')!)!;
/** A finger held on a button and lifted: the browser's click follows a lift (not a cancel). */
function hold(b: Element, ms: number) {
  ptr(b, 'pointerdown', 'touch');
  tick(ms);
  ptr(b, 'pointerup', 'touch');
  fireEvent.click(b);
}

const COPY: Record<string, string> = {
  Keyboard: 'Open your keyboard to type into the field you tapped.',
  "Can't solve": "Hand the page back to the agent and say why you couldn't finish.",
  Done: 'Finished. The agent takes the page back.',
  'Zoom in': 'Zoom in (or pinch).',
  'Zoom out': 'Zoom out.',
  'Fit page to screen': 'Fit the page to the screen.',
  'Scroll up': 'Scroll the page up.',
  'Scroll down': 'Scroll the page down.',
  'Drag mode': 'Drag mode: off. Swipe to move, hold to drag.',
  Help: 'How to tap, move, drag and zoom.',
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(HINT_SEEN_KEY, '1'); // the first-time hint has its own tests
  sent = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('control buttons', () => {
  it('every button has a hidden icon, keeps its name, and is described by its tooltip', () => {
    live();
    for (const [name, copy] of Object.entries(COPY)) {
      const b = btn(name);
      const icon = b.querySelector('svg')!;
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.getAttribute('focusable')).toBe('false');
      const tip = tipOf(b);
      expect(tip.getAttribute('role')).toBe('tooltip');
      expect(tip.textContent).toBe(copy);
      expect(tip.hidden).toBe(true);
    }
    // Bar buttons are named by their visible label, the icon-only rail buttons by aria-label.
    expect(btn('Done').getAttribute('aria-label')).toBeNull();
    expect(btn('Zoom in').getAttribute('aria-label')).toBe('Zoom in');
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Every button in the tool rail and the top bar has a tooltip.
    for (const b of document.querySelectorAll('.stage-controls button, .topbar button')) expect(tipOf(b).getAttribute('role')).toBe('tooltip');
    expect(document.querySelectorAll('.stage-controls button')).toHaveLength(6);
    // Help's tooltip opens below it (it sits in the top bar), lined up with its right edge.
    expect(anchor('Help').className).toBe('tip-anchor tip-bottom tip-align-end');
  });

  it('a long-press shows the tooltip and its release does not press the button', () => {
    live();
    hold(btn('Done'), LONG_PRESS_MS);
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe(COPY.Done);
    expect(btn('Done').getAttribute('aria-describedby')).toBe(tip.id);
    expect(anchor('Done').hasAttribute('data-open')).toBe(true);
    expect(sent).toEqual([]);
    tick(TOUCH_TIP_MS);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Later, a plain tap presses it again.
    tick(1000);
    hold(btn('Done'), 80);
    expect(sent).toEqual([{ t: 'done' }]);
  });

  it("a long-press on Can't solve (or a pen) opens no sheet", () => {
    live();
    ptr(btn("Can't solve"), 'pointerdown', 'pen');
    tick(LONG_PRESS_MS);
    ptr(btn("Can't solve"), 'pointerup', 'pen');
    fireEvent.click(btn("Can't solve"));
    expect(screen.getByRole('tooltip').textContent).toBe(COPY["Can't solve"]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a short tap fires at once and shows no tooltip', () => {
    live();
    hold(btn('Done'), 120);
    expect(sent).toEqual([{ t: 'done' }]);
    tick(LONG_PRESS_MS);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a finger that slides off is not a long-press', () => {
    live();
    const b = btn('Done');
    ptr(b, 'pointerdown', 'touch', 10, 10);
    ptr(b, 'pointermove', 'touch', 14, 12); // within the slop: still a press
    ptr(b, 'pointermove', 'touch', 40, 10);
    tick(LONG_PRESS_MS);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('the next touch anywhere hides a tooltip', () => {
    live();
    hold(btn('Zoom in'), LONG_PRESS_MS);
    expect(screen.getByRole('tooltip').textContent).toBe(COPY['Zoom in']);
    ptr(screen.getByTestId('screen'), 'pointerdown', 'touch');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a cancelled long-press leaves the button working (no click was coming)', () => {
    live();
    const b = btn('Done');
    ptr(b, 'pointerdown', 'touch');
    tick(LONG_PRESS_MS);
    ptr(b, 'pointercancel', 'touch');
    fireEvent.click(b); // e.g. Enter on a keyboard
    expect(sent).toEqual([{ t: 'done' }]);
  });

  it('only the click right after a long-press is ignored', () => {
    live();
    const b = btn('Done');
    ptr(b, 'pointerdown', 'touch');
    tick(LONG_PRESS_MS);
    ptr(b, 'pointerup', 'touch');
    ptr(b, 'pointerleave', 'touch'); // a finger leaving is not a mouse leaving: the tooltip stays
    expect(screen.getByRole('tooltip')).toBeTruthy();
    tick(1000); // the lift's click never came
    fireEvent.click(b);
    expect(sent).toEqual([{ t: 'done' }]);
  });

  it('a disabled rail button still shows its tooltip, and never fires', () => {
    live();
    const out = btn('Zoom out');
    expect(out.disabled).toBe(true);
    // A disabled button takes no pointer events: they land on its wrapper.
    ptr(out.parentElement!, 'pointerdown', 'touch');
    tick(LONG_PRESS_MS);
    expect(screen.getByRole('tooltip').textContent).toBe(COPY['Zoom out']);
  });

  it('hover shows the tooltip after a moment; leaving hides it', () => {
    live();
    const a = anchor('Scroll up');
    ptr(a, 'pointerenter', 'mouse');
    tick(HOVER_MS - 1);
    expect(screen.queryByRole('tooltip')).toBeNull();
    tick(1);
    expect(screen.getByRole('tooltip').textContent).toBe(COPY['Scroll up']);
    ptr(a, 'pointerleave', 'mouse');
    expect(screen.queryByRole('tooltip')).toBeNull();
    // A click before the delay is up cancels it; a touch "enter" never starts one.
    ptr(a, 'pointerenter', 'mouse');
    ptr(btn('Scroll up'), 'pointerdown', 'mouse');
    ptr(a, 'pointerenter', 'touch');
    tick(HOVER_MS);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('keyboard focus shows the tooltip, Esc hides it and is not sent to the page', () => {
    live();
    fireEvent.keyDown(window, { key: 'Tab', code: 'Tab' });
    sent = [];
    act(() => btn('Keyboard').focus());
    expect(screen.getByRole('tooltip').textContent).toBe(COPY.Keyboard);
    fireEvent.keyDown(btn('Keyboard'), { key: 'Escape', code: 'Escape' });
    fireEvent.keyUp(btn('Keyboard'), { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(sent).toEqual([]);
    // With no tooltip open, Esc goes to the page as before.
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(sent.map((m) => m.key)).toEqual(['Escape']);
    // Focus moving away hides it too.
    act(() => btn('Done').focus());
    expect(screen.getByRole('tooltip').textContent).toBe(COPY.Done);
    act(() => btn('Done').blur());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('focus from a tap or click shows no tooltip', () => {
    live();
    ptr(btn('Done'), 'pointerdown', 'mouse');
    act(() => btn('Done').focus());
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('the long-press menu is turned off on the buttons', () => {
    live();
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => void btn('Done').dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
  });

  it('Keyboard is lit (data-active) while the phone keyboard is open, and is not a toggle', () => {
    live();
    const k = btn('Keyboard');
    expect(k.hasAttribute('data-active')).toBe(false);
    fireEvent.click(k);
    expect(document.activeElement).toBe(screen.getByTestId('keyboard-bridge'));
    expect(k.hasAttribute('data-active')).toBe(true);
    act(() => (screen.getByTestId('keyboard-bridge') as HTMLInputElement).blur());
    expect(k.hasAttribute('data-active')).toBe(false);
    // Only Drag mode is a real toggle.
    for (const name of Object.keys(COPY)) expect(btn(name).hasAttribute('aria-pressed'), name).toBe(name === 'Drag mode');
  });

  it('Esc hides a hover or long-press tooltip and still goes to the page', () => {
    live();
    hold(btn('Done'), LONG_PRESS_MS);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    fireEvent.keyUp(window, { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(sent.filter((m) => m.t === 'key').map((m) => m.key)).toEqual(['Escape', 'Escape']);
    const a = anchor('Zoom in');
    ptr(a, 'pointerenter', 'mouse');
    tick(HOVER_MS);
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(sent.filter((m) => m.t === 'key')).toHaveLength(3);
  });

  it("Done's tooltip keeps clear of the tool rail above it", () => {
    live();
    const rail = btn('Zoom in').closest('.stage-controls')!;
    const rect = (left: number, right: number) => () => ({ left, right, width: right - left, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) });
    rail.getBoundingClientRect = rect(294, 348);
    anchor('Done').getBoundingClientRect = rect(219, 348);
    hold(btn('Done'), LONG_PRESS_MS);
    expect(anchor('Done').style.getPropertyValue('--tip-clear')).toBe('62px');
    // No rail laid out (width 0): nothing to keep clear of.
    tick(TOUCH_TIP_MS);
    rail.getBoundingClientRect = rect(0, 0);
    tick(1000);
    hold(btn('Done'), LONG_PRESS_MS);
    expect(anchor('Done').style.getPropertyValue('--tip-clear')).toBe('');
  });
});

describe('first-time hint', () => {
  const hint = () => screen.queryByRole('note');

  it('shows once on this device, the first time the viewer is live', () => {
    localStorage.clear();
    const r = live();
    expect(hint()?.textContent).toBe(HINT_MOUSE); // jsdom: no touch screen
    expect(localStorage.getItem(HINT_SEEN_KEY)).toBe('1');
    tick(HINT_MS);
    expect(hint()).toBeNull();
    r.unmount();
    live();
    expect(hint()).toBeNull();
  });

  it('a tap dismisses it, and then stops listening', () => {
    localStorage.clear();
    const off = vi.spyOn(document, 'removeEventListener');
    live();
    ptr(screen.getByRole('note'), 'pointerdown', 'touch');
    expect(hint()).toBeNull();
    expect(off.mock.calls.filter(([type, , capture]) => type === 'pointerdown' && capture === true).length).toBeGreaterThanOrEqual(1);
  });

  it('on a touch screen it teaches swipe to move, hold to drag, and points to help', () => {
    expect(HINT_TOUCH).toMatch(/^Swipe to move, press and hold to drag\./);
    expect(HINT_TOUCH).toContain('tap ? for help');
    expect(HINT_MOUSE).toContain('click ? for help');
  });

  it('on a touch screen it says press and hold', () => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' }));
    live();
    expect(hint()?.textContent).toBe(HINT_TOUCH);
    cleanup();
    localStorage.clear();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(hover: none)' }));
    live();
    expect(hint()?.textContent).toBe(HINT_TOUCH);
    vi.unstubAllGlobals();
  });

  it('not before the session is live, and gone if it stops being live', () => {
    localStorage.clear();
    render(<App location={{ hash: `#t=TOK&k=${KEY}`, pathname: '/s/SESSION', origin: 'http://127.0.0.1:5000' }} connectFn={connectFn} drawFrame={vi.fn()} now={() => NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start takeover' }));
    expect(hint()).toBeNull();
    act(() => handlers.onPhase('live'));
    expect(hint()).toBeTruthy();
    act(() => handlers.onPhase('reconnecting'));
    expect(hint()).toBeNull();
    act(() => handlers.onPhase('live'));
    expect(hint()).toBeNull(); // once per page load, and remembered
  });

  it('with storage blocked it still shows (it cannot be remembered)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    live();
    expect(hint()).toBeTruthy();
  });
});

describe('TipButton', () => {
  function Harness({ onClick }: { onClick: () => void }) {
    const tips = useTips();
    return (
      <>
        <TipButton tips={tips} id="a" side="top" class="x" tip="First." onClick={onClick}>
          A
        </TipButton>
        <TipButton tips={tips} id="b" side="left" class="x" label="Bee" tip="Second." onClick={onClick}>
          <svg />
        </TipButton>
      </>
    );
  }

  it('one tooltip at a time; hiding another id leaves it; unmounting clears its timers', () => {
    const onClick = vi.fn();
    const r = render(<Harness onClick={onClick} />);
    hold(screen.getByRole('button', { name: 'A' }), LONG_PRESS_MS);
    expect(screen.getByRole('tooltip').textContent).toBe('First.');
    fireEvent.keyDown(window, { key: 'Tab' });
    act(() => screen.getByRole('button', { name: 'Bee' }).focus());
    expect(screen.getAllByRole('tooltip').map((t) => t.textContent)).toEqual(['Second.']);
    act(() => screen.getByRole('button', { name: 'A' }).blur()); // A was not open: nothing changes
    expect(screen.getByRole('tooltip').textContent).toBe('Second.');
    // A second hold before the first's click-guard runs out restarts it.
    hold(screen.getByRole('button', { name: 'A' }), LONG_PRESS_MS);
    ptr(screen.getByRole('button', { name: 'A' }), 'pointerdown', 'touch');
    tick(LONG_PRESS_MS);
    ptr(screen.getByRole('button', { name: 'A' }), 'pointerup', 'touch');
    ptr(screen.getByRole('button', { name: 'A' }).parentElement!, 'pointerenter', 'mouse');
    ptr(screen.getByRole('button', { name: 'A' }), 'pointerdown', 'touch');
    r.unmount();
    tick(5000);
    expect(onClick).not.toHaveBeenCalled();
  });
});
