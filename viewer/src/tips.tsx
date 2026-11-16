/*
 * Tooltips for the viewer's controls, and the one-time "press and hold" hint.
 *
 * - Touch (or pen): press and hold a button for LONG_PRESS_MS to see its tooltip. Letting go after that does NOT press
 *   the button; the tooltip hides after TOUCH_TIP_MS or at the next touch anywhere. A short tap presses it as always.
 * - Mouse: the tooltip shows after hovering HOVER_MS and hides when the pointer leaves.
 * - Keyboard: the tooltip shows while the button has focus (reached by keyboard, not by a tap or click); Esc hides it.
 * Only one tooltip is open at a time. Each tooltip is always in the page (hidden until shown) and linked to its button
 * with aria-describedby, so a screen reader reads it as the button's description; the button keeps its own name.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export const LONG_PRESS_MS = 450;
export const TOUCH_TIP_MS = 2500;
export const HOVER_MS = 400;
export const HINT_MS = 6000;
/** A finger that moves more than this (CSS px) while held is not a long-press. */
const PRESS_SLOP_PX = 10;
/** After a long-press, the click the release would make is ignored for this long (it follows the lift at once). */
const SUPPRESS_MS = 800;
export const HINT_SEEN_KEY = 'unstuck:tips-seen';

export interface Tips {
  /** The open tooltip's id, if any. */
  open: string | null;
  show(id: string, autoHide: boolean): void;
  /** Hides the tooltip `id` (or whichever is open). */
  hide(id?: string): void;
  /** True when the last input was a key, not a pointer: focus then shows a tooltip. */
  keyboard(): boolean;
}

export function useTips(): Tips {
  const [open, setOpen] = useState<string | null>(null);
  const r = useRef<{ open: string | null; timer: ReturnType<typeof setTimeout> | null; keyboard: boolean; swallowEsc: boolean }>({
    open: null,
    timer: null,
    keyboard: true,
    swallowEsc: false,
  }).current;
  const set = (id: string | null) => {
    r.open = id;
    setOpen(id);
  };
  const stopTimer = () => {
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
  };
  const api = useRef<Omit<Tips, 'open'>>({
    show(id, autoHide) {
      stopTimer();
      set(id);
      if (autoHide) r.timer = setTimeout(() => set((r.timer = null)), TOUCH_TIP_MS);
    },
    hide(id) {
      if (r.open === null || (id !== undefined && r.open !== id)) return;
      stopTimer();
      set(null);
    },
    keyboard: () => r.keyboard,
  }).current;

  useEffect(() => {
    // Any new touch or click closes the open tooltip (capture: before the mirror or a button handles it).
    const down = () => {
      r.keyboard = false;
      api.hide();
    };
    const key = (e: KeyboardEvent) => {
      if (e.type === 'keydown') r.keyboard = true;
      if (e.key !== 'Escape') return;
      // Esc that closes a tooltip is for the tooltip only: it is not sent on to the agent's page.
      if (e.type === 'keydown' && r.open !== null) {
        api.hide();
        r.swallowEsc = true;
      } else if (e.type === 'keyup' && r.swallowEsc) r.swallowEsc = false;
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', key, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', key, true);
      stopTimer();
    };
  }, []);

  return { open, ...api };
}

export interface TipButtonProps {
  tips: Tips;
  id: string;
  tip: string;
  /** Where the tooltip opens: above (the bottom bar) or to the left (the tool rail). */
  side: 'top' | 'left';
  /** For `top`: which edge of the button the bubble lines up with, so it stays on screen at the bar's ends. */
  align?: 'start' | 'center' | 'end';
  class: string;
  /** The accessible name of an icon-only button. */
  label?: string;
  disabled?: boolean;
  /** A toggle's state (aria-pressed); leave out for a plain button. */
  pressed?: boolean;
  onClick: () => void;
  children: ComponentChildren;
}

export function TipButton({ tips, id, tip, side, align = 'center', class: cls, label, disabled, pressed, onClick, children }: TipButtonProps) {
  const wrap = useRef<HTMLSpanElement>(null);
  const tipId = `tip-${id}`;
  const open = tips.open === id;

  useEffect(() => {
    // On the wrapper, not the button: a disabled button takes no pointer events (pointer-events: none in CSS), so its
    // tooltip still shows. Attached directly: jsdom and some browsers have no onpointer* properties for Preact to use.
    const el = wrap.current!;
    let press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
    let hover: ReturnType<typeof setTimeout> | null = null;
    let suppress = false;
    let unsuppress: ReturnType<typeof setTimeout> | null = null;
    const endPress = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    const endHover = () => {
      if (hover) clearTimeout(hover);
      hover = null;
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return endHover();
      endPress();
      suppress = false;
      press = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          press = null;
          suppress = true;
          tips.show(id, true);
        }, LONG_PRESS_MS),
      };
    };
    const move = (e: PointerEvent) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > PRESS_SLOP_PX) endPress();
    };
    const up = () => {
      endPress();
      if (!suppress) return;
      if (unsuppress) clearTimeout(unsuppress);
      unsuppress = setTimeout(() => (suppress = false), SUPPRESS_MS);
    };
    const cancel = () => {
      endPress();
      suppress = false; // no click follows a cancelled touch
    };
    const enter = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && !hover) hover = setTimeout(() => ((hover = null), tips.show(id, false)), HOVER_MS);
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      endHover();
      tips.hide(id);
    };
    // The release of a long-press is not a press of the button.
    const click = (e: Event) => {
      if (!suppress) return;
      suppress = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // No long-press menu or text selection on a button (Android, iOS).
    const menu = (e: Event) => e.preventDefault();
    const on: [string, (e: never) => void, boolean?][] = [
      ['pointerdown', down],
      ['pointermove', move],
      ['pointerup', up],
      ['pointercancel', cancel],
      ['pointerenter', enter],
      ['pointerleave', leave],
      ['click', click, true],
      ['contextmenu', menu],
    ];
    for (const [type, fn, capture] of on) el.addEventListener(type, fn as EventListener, capture);
    return () => {
      for (const [type, fn, capture] of on) el.removeEventListener(type, fn as EventListener, capture);
      endPress();
      endHover();
      if (unsuppress) clearTimeout(unsuppress);
    };
  }, []);

  return (
    <span ref={wrap} class={`tip-anchor tip-${side} tip-align-${align}`} data-open={open ? '' : undefined}>
      <button
        type="button"
        class={cls}
        aria-label={label}
        aria-describedby={tipId}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        onFocus={() => tips.keyboard() && tips.show(id, false)}
        onBlur={() => tips.hide(id)}
      >
        {children}
      </button>
      <span class="tip" role="tooltip" id={tipId} hidden={!open}>
        {tip}
      </span>
    </span>
  );
}

/**
 * The first time the viewer is live on this device: true until the hint is dismissed (any touch or click, or
 * HINT_MS). Remembered in localStorage; where storage is blocked it shows once per page load.
 */
export function useFirstTimeHint(active: boolean): boolean {
  const [shown, setShown] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    if (!active || done.current) return;
    done.current = true;
    try {
      if (localStorage.getItem(HINT_SEEN_KEY) !== null) return;
      localStorage.setItem(HINT_SEEN_KEY, '1');
    } catch {
      // storage blocked: show it, it can't be remembered
    }
    setShown(true);
    const off = () => setShown(false);
    const timer = setTimeout(off, HINT_MS);
    document.addEventListener('pointerdown', off, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', off, true);
      off();
    };
  }, [active]);
  return shown;
}
