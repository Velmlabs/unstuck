/*
 * The help sheet: what each gesture and button does, one short line each, with the icons the controls use. A modal
 * dialog over the whole viewer: focus moves to its Close button and back to Help when it closes (Close, Esc, or a tap
 * outside the card). While it is open the mirror takes no input (App), and the session carries on underneath.
 */
import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, DragIcon, FlagIcon, HoldDragIcon, KeyboardIcon, SwipeIcon, TapIcon, ZoomInIcon } from './icons';

export interface HelpItem {
  icon: () => ComponentChildren;
  /** Two icons for one line (the scroll buttons). */
  icon2?: () => ComponentChildren;
  name: string;
  text: string;
}

export const HELP_ITEMS: HelpItem[] = [
  { icon: TapIcon, name: 'Tap', text: 'Click on the page.' },
  { icon: SwipeIcon, name: 'Swipe', text: 'Move around: pans when zoomed in, then scrolls the page.' },
  { icon: HoldDragIcon, name: 'Press and hold, then drag', text: 'For sliders and puzzle pieces.' },
  { icon: ZoomInIcon, name: 'Pinch, Zoom in, Zoom out', text: 'Zoom. Fit page to screen shows the whole page.' },
  { icon: ChevronUpIcon, icon2: ChevronDownIcon, name: 'Scroll up, Scroll down', text: 'Scroll the page.' },
  { icon: DragIcon, name: 'Drag mode', text: 'When on, swipes drag on the page (for long drag puzzles).' },
  { icon: KeyboardIcon, name: 'Keyboard', text: 'Type into the page.' },
  { icon: FlagIcon, name: "Can't solve", text: 'Give it back to the agent unsolved.' },
  { icon: CheckIcon, name: 'Done', text: 'Finished: hand it back to the agent.' },
];

export function HelpSheet({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current!.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab') {
        // Close is the only control in the dialog: focus stays on it.
        e.preventDefault();
        close.current!.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <div
      class="sheet help-sheet"
      data-testid="help-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(); // a tap outside the card
      }}
    >
      <div class="sheet-card help-card" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <div class="help-head">
          <h2 id="help-title">How to use this screen</h2>
          <button ref={close} type="button" class="btn btn-ghost help-close" onClick={onClose}>
            Close
          </button>
        </div>
        <ul class="help-list">
          {HELP_ITEMS.map(({ icon: I, icon2: I2, name, text }) => (
            <li key={name}>
              <span class="help-icon">
                <I />
                {I2 ? <I2 /> : null}
              </span>
              <span>
                <strong>{name}</strong> <span class="help-text">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
