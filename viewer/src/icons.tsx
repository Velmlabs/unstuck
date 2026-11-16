/*
 * The viewer's control icons: one outline family on a 24 px grid, 2 px round strokes, drawn for Unstuck (no icon
 * library, nothing to vendor). Decorative only: every button that shows one carries its own text or aria-label, so
 * the icon is hidden from assistive tech and never takes focus.
 */
import type { ComponentChildren } from 'preact';

function Icon({ size = 20, children }: { size?: number; children: ComponentChildren }) {
  return (
    <svg
      class="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const KeyboardIcon = () => (
  <Icon>
    <rect x="2.5" y="5.5" width="19" height="13" rx="2.5" />
    <path d="M6.5 9.5h.01M10 9.5h.01M14 9.5h.01M17.5 9.5h.01M6.5 12.5h.01M17.5 12.5h.01M10 12.5h4M8 15.5h8" />
  </Icon>
);

/** Can't solve: a flag, "I give up, over to you" (neutral, not an error). */
export const FlagIcon = () => (
  <Icon>
    <path d="M5 21V4" />
    <path d="M5 4.5c1.8-1 3.6-1 5.4 0s3.8 1 5.6 0c.6-.3 1 0 1 .6v8.3c0 .4-.2.7-.5.9-1.8 1-3.6 1-5.5 0s-3.8-1-5.6 0" />
  </Icon>
);

export const CheckIcon = () => (
  <Icon>
    <path d="M4.5 12.5l5 5L19.5 7" />
  </Icon>
);

export const ZoomInIcon = () => (
  <Icon>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L20 20M10.5 7.75v5.5M7.75 10.5h5.5" />
  </Icon>
);

export const ZoomOutIcon = () => (
  <Icon>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L20 20M7.75 10.5h5.5" />
  </Icon>
);

/** Fit: the page drawn inside the screen's corners. */
export const FitIcon = () => (
  <Icon>
    <path d="M4 8.5V5.5A1.5 1.5 0 0 1 5.5 4h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3" />
    <rect x="8" y="8" width="8" height="8" rx="1.5" />
  </Icon>
);

export const ChevronUpIcon = () => (
  <Icon>
    <path d="M6 15l6-6 6 6" />
  </Icon>
);

export const ChevronDownIcon = () => (
  <Icon>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);
