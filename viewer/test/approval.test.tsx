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

  it('a frame with no preview canvas yet is still acknowledged', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.({ ...approvalMode, mode: 'question', question: { text: 'Q?', allowText: true } }));
    const frame = { width: 4, height: 3, jpeg: new Uint8Array([1]), seq: 1 };
    act(() => a.h().onFrame(frame));
    expect(a.drawFrame).not.toHaveBeenCalled();
    expect(a.acked).toEqual([frame]); // nothing to draw on, but the engine's credit is still returned
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

  it('a resolved approval says Approved, thank you', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(approvalMode));
    act(() => a.h().onState('resolved'));
    expect(screen.getByRole('heading', { name: 'Approved, thank you' })).toBeTruthy();
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
