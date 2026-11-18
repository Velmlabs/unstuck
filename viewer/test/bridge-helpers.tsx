import { vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/preact';
import type { ConnectionHandlers } from '../src/connection';
import { App, type AppProps } from '../src/App';

export const NOW = 1_700_000_000_000;
export const KEY = 'A'.repeat(43);

/** A fake socket: records what the viewer sends and hands the test the handlers the App registered. */
export interface FakeApp {
  sent: unknown[];
  acked: unknown[];
  drawFrame: ReturnType<typeof vi.fn>;
  h: () => ConnectionHandlers;
  ready: () => void;
}
export function fakeApp(search = ''): FakeApp {
  const sent: unknown[] = [];
  const acked: unknown[] = [];
  const box: { h: ConnectionHandlers | null } = { h: null };
  const connectFn: AppProps['connectFn'] = (_url, _t, _c, h) => {
    box.h = h;
    return { send: (m) => void sent.push(m), sendHello: () => {}, close: () => {}, wake: () => {}, ack: (f) => void acked.push(f) };
  };
  const drawFrame = vi.fn();
  const location = { hash: `#t=TOK&k=${KEY}`, pathname: '/s/SESSION', origin: 'http://127.0.0.1:5000', search };
  render(<App location={location} connectFn={connectFn} drawFrame={drawFrame} now={() => NOW} />);
  const b = screen.queryByRole('button', { name: 'Start takeover' });
  if (b) fireEvent.click(b);
  const h = () => box.h!;
  const ready = () =>
    act(() => {
      h().onPhase('live');
      h().onReady({ t: 'ready', reason: 'Approve the sign-in', site: 'accounts.example.com', expiresAt: NOW + 125_000, resumeKey: 'k' });
    });
  return { sent, acked, drawFrame, h, ready };
}
