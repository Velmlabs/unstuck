import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, fireEvent, act, cleanup } from '@testing-library/preact';
import { fakeApp } from './bridge-helpers';

const ask = (question: { text: string; choices?: string[]; allowText: boolean; details?: string }, agentName?: string) =>
  ({ t: 'mode', mode: 'question', reason: 'Book the flight?', site: '', question, ...(agentName ? { agentName } : {}) }) as const;
beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe('question screen', () => {
  it('shows the agent name, question, details and choices', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'Book the 08:15 flight?', details: 'It is over budget.', choices: ['Yes', 'No'], allowText: false }, 'Flight booker')));
    expect(screen.getByText('Flight booker asks')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Book the 08:15 flight?' })).toBeTruthy();
    expect(screen.getByText('It is over budget.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a choice then Send answer sends {t:"answer",choice}', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'Go?', choices: ['Yes', 'No'], allowText: false })));
    expect(screen.getByText('Your agent asks')).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(screen.getByRole('button', { name: 'No' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(send);
    expect(a.sent).toContainEqual({ t: 'answer', choice: 1 });
  });

  it('free text is sent only when allowText; Send is disabled while empty', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'Which date?', allowText: true })));
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const input = screen.getByLabelText('Your answer') as HTMLInputElement;
    expect(input.maxLength).toBe(500);
    fireEvent.input(input, { target: { value: '   ' } });
    expect(send.disabled).toBe(true);
    fireEvent.input(input, { target: { value: ' 12 May ' } });
    fireEvent.click(send);
    expect(a.sent).toContainEqual({ t: 'answer', text: '12 May' });
  });

  it('with choices and text, typing replaces the choice and a choice clears the text', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'Go?', choices: ['Yes', 'No'], allowText: true })));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    const input = screen.getByLabelText('Or write a reply') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'maybe' } });
    expect(screen.getByRole('button', { name: 'Yes' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(input.value).toBe('');
    fireEvent.submit(input.closest('form')!);
    expect(a.sent).toContainEqual({ t: 'answer', choice: 1 });
  });

  it('submitting with nothing chosen sends nothing', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'Which?', allowText: true })));
    fireEvent.submit(screen.getByLabelText('Your answer').closest('form')!);
    expect(a.sent.filter((m) => (m as { t: string }).t === 'answer')).toEqual([]);
  });

  it('state with answer shows Answer sent and the echoed label', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'Go?', choices: ['Yes', 'No'], allowText: false })));
    act(() => a.h().onState('answered', { choice: 0, label: 'Yes' }));
    expect(screen.getByRole('heading', { name: 'Answer sent' })).toBeTruthy();
    expect(screen.getByText(/Yes/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
  });

  it('an answered state clears the saved key and closes the socket', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'Go?', choices: ['Yes', 'No'], allowText: false })));
    expect(localStorage.getItem('unstuck:resume:SESSION')).toBe('k');
    act(() => a.h().onState('answered', { choice: 0, label: 'Yes' }));
    expect(localStorage.getItem('unstuck:resume:SESSION')).toBeNull();
    expect(a.closed()).toBe(true);
  });

  it('two submits in one tick send one answer', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'Which?', allowText: true })));
    const input = screen.getByLabelText('Your answer') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'x' } });
    const form = input.closest('form')!;
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(a.sent.filter((m) => (m as { t: string }).t === 'answer')).toHaveLength(1);
  });

  it('an error from the engine lets the person send again', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'Go?', choices: ['Yes', 'No'], allowText: false })));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => a.h().onError('bad_message', 'nope'));
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(a.sent.filter((m) => (m as { t: string }).t === 'answer')).toHaveLength(2);
  });

  it('echoes typed text, and copes with an answered state without an answer', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'When?', allowText: true })));
    act(() => a.h().onState('answered', { text: 'Tomorrow' }));
    expect(screen.getByText(/Tomorrow/)).toBeTruthy();
    cleanup();
    const b = fakeApp();
    b.ready();
    act(() => b.h().onState('answered'));
    expect(screen.getByRole('heading', { name: 'Answer sent' })).toBeTruthy();
  });

  it('embed=1 shows the question with no brand bar or timer', () => {
    const a = fakeApp('?embed=1');
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'Go?', choices: ['Yes', 'No'], allowText: false })));
    expect(document.querySelector('.bridge-bar')).toBeNull();
    expect(document.querySelector('.topbar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy();
  });

  it('shows the timer outside embed', () => {
    const a = fakeApp();
    a.ready();
    act(() => a.h().onMode?.(ask({ text: 'Go?', choices: ['Yes', 'No'], allowText: false })));
    expect(document.querySelector('.bridge-bar')).toBeTruthy();
    expect(screen.getByTestId('countdown').textContent).toBe('2:05');
  });
});
