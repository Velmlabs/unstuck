import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, act, cleanup } from '@testing-library/preact';
import { fakeApp } from './bridge-helpers';

const approvalMode = { t: 'mode', mode: 'approval', reason: 'Approve the sign-in', site: 'accounts.example.com' } as const;
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe('approval screen', () => {
  it("shows reason, site and the preview; I've approved it sends approved", () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(approvalMode));
    expect(screen.getByRole('heading', { name: 'Approve the sign-in' })).toBeTruthy();
    expect(screen.getByText('accounts.example.com')).toBeTruthy();
    expect(screen.getByText(/Watching the page for your approval/)).toBeTruthy();
    const frame = { width: 400, height: 300, jpeg: new Uint8Array([1]) };
    act(() => a.h().onFrame(frame));
    const preview = screen.getByLabelText(/preview of the agent's page/i) as HTMLCanvasElement;
    expect(a.drawFrame).toHaveBeenCalledWith(preview, frame, expect.any(Function));
    fireEvent.click(screen.getByRole('button', { name: "I've approved it" }));
    expect(a.sent).toContainEqual({ t: 'approved' });
  });

  it('a frame in question mode is acknowledged but not drawn', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.({ ...approvalMode, mode: 'question', question: { text: 'Q?', allowText: true } }));
    const frame = { width: 4, height: 3, jpeg: new Uint8Array([1]), seq: 1 };
    act(() => a.h().onFrame(frame));
    expect(a.drawFrame).not.toHaveBeenCalled();
    expect(a.acked).toEqual([frame]); // nothing to draw on, but the engine's credit is still returned
  });

  it('a frame right behind the mode frame (same tick) is drawn on the preview', () => {
    const a = fakeApp();
    a.ready();
    const frame = { width: 400, height: 300, jpeg: new Uint8Array([1]) };
    act(() => {
      a.h().onMode?.(approvalMode);
      a.h().onFrame(frame);
    });
    expect(a.drawFrame).toHaveBeenCalledTimes(1);
    expect(a.drawFrame.mock.calls[0]![0]).toBe(screen.getByLabelText(/preview of the agent's page/i));
  });

  it('Show me the page sends switch_control, and a control mode frame shows the live view', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(approvalMode));
    expect(screen.queryByTestId('screen')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show me the page' }));
    expect(a.sent).toContainEqual({ t: 'switch_control' });
    act(() => a.h().onMode?.({ ...approvalMode, mode: 'control' }));
    expect(screen.getByTestId('screen')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();

  });

  it('after Show me the page the live view waits for its own first frame (preview frame or question frame before)', () => {
    const frame = { width: 400, height: 300, jpeg: new Uint8Array([1]) };
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(approvalMode));
    act(() => a.h().onFrame(frame)); // drawn on the preview
    act(() => a.h().onMode?.({ ...approvalMode, mode: 'control' }));
    expect(screen.getByText('Waiting for the page…')).toBeTruthy();
    cleanup();
    const b = fakeApp();
    b.ready();
    act(() => b.h().onMode?.({ ...approvalMode, mode: 'question', question: { text: 'Q?', allowText: true } }));
    act(() => b.h().onFrame(frame)); // drawn nowhere
    act(() => b.h().onMode?.({ ...approvalMode, mode: 'control' }));
    expect(screen.getByText('Waiting for the page…')).toBeTruthy();
  });

  it('a held preview frame is acked once when the mode leaves approval, and once when replaced', () => {
    const a = fakeApp();
    a.ready();
    const f1 = { width: 4, height: 3, jpeg: new Uint8Array([1]), seq: 1 };
    const f2 = { ...f1, seq: 2 };
    // Mode frame and two frames in one tick: the preview isn't mounted, so f1 is held, then replaced by f2.
    act(() => {
      a.h().onMode?.(approvalMode);
      a.h().onFrame(f1);
      a.h().onFrame(f2);
    });
    expect(a.acked).toEqual([f1]); // f1 replaced: acked; f2 drawn on the preview (drawFrame is a mock: ack is its job)
    expect(a.acked.filter((x) => x === f1)).toHaveLength(1);
    cleanup();
    // Held frame discarded by a mode change before the effect runs (nothing is mounted yet).
    const b = fakeApp();
    b.ready();
    const f3 = { ...f1, seq: 3 };
    act(() => {
      b.h().onMode?.(approvalMode);
      b.h().onFrame(f3);
      b.h().onMode?.({ ...approvalMode, mode: 'control' });
    });
    expect(b.acked).toEqual([f3]);
    expect(b.drawFrame).not.toHaveBeenCalled();
  });

  it('a resolved approval says Approved, thank you', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(approvalMode));
    act(() => a.h().onState('resolved'));
    expect(screen.getByRole('heading', { name: 'Approved, thank you' })).toBeTruthy();
  });

  it('the engine judging the page shows Checking the page…, before any tap', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(approvalMode));
    expect(screen.queryByText('Checking the page…')).toBeNull();
    act(() => a.h().onState('active')); // the prompt went away: the engine checks the page
    expect(screen.getByText('Checking the page…')).toBeTruthy();
    expect(screen.getByRole('button', { name: "I've approved it" })).toBeTruthy(); // still the waiting page
  });

  it("a failed approval says the sign-in didn't go through", () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(approvalMode));
    fireEvent.click(screen.getByRole('button', { name: "I've approved it" }));
    act(() => a.h().onState('active'));
    act(() => a.h().onState('failed'));
    expect(screen.getByRole('heading', { name: "The sign-in didn't go through" })).toBeTruthy();
    expect(screen.getByText(/Your agent will try again or ask you/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Approved, thank you' })).toBeNull();
  });

  it('a failed session after Show me the page shows the usual failed screen', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(approvalMode));
    act(() => a.h().onMode?.({ ...approvalMode, mode: 'control' }));
    act(() => a.h().onState('failed'));
    expect(screen.getByRole('heading', { name: 'The page closed or something went wrong' })).toBeTruthy();
  });

  it('embed=1 hides the top bar and help', () => {
    const a = fakeApp('?embed=1');
    a.ready();
    act(() => a.h().onFrame({ width: 4, height: 3, jpeg: new Uint8Array([1]) }));
    expect(document.querySelector('.topbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Help' })).toBeNull();
    expect(screen.getByTestId('screen')).toBeTruthy(); // the live view is still there
  });

  it('a viewer that never receives a mode frame behaves as today', () => {
    const a = fakeApp();
    a.ready();
    expect(document.querySelector('.topbar')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Help' })).toBeTruthy();
    expect(screen.getByTestId('screen')).toBeTruthy();
    expect(screen.queryByRole('button', { name: "I've approved it" })).toBeNull();
  });

  it('approval and embed together: no brand bar', () => {
    const a = fakeApp('?embed=1');
    a.ready();
    act(() => a.h().onMode?.(approvalMode));
    expect(screen.getByRole('button', { name: "I've approved it" })).toBeTruthy();
    expect(document.querySelector('.bridge-bar')).toBeNull();
  });
});
