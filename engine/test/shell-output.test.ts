import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { EXIT, emit, exitFor } from '../src/shell/output';

const sink = () => {
  const s = new PassThrough();
  let text = '';
  s.on('data', (d) => (text += String(d)));
  return { s, text: () => text };
};

describe('shell output', () => {
  it('emit writes one JSON line and returns the code', () => {
    const out = sink();
    const err = sink();
    const code = emit({ stdout: out.s, stderr: err.s }, { status: 'clear' }, EXIT.done, 'No human check on this page.');
    expect(code).toBe(0);
    expect(out.text()).toBe('{"status":"clear"}\n');
    expect(err.text()).toBe('[unstuck] No human check on this page.\n');
  });

  it('emit without a human line writes nothing to stderr', () => {
    const out = sink();
    const err = sink();
    emit({ stdout: out.s, stderr: err.s }, { a: 1 }, 2);
    expect(err.text()).toBe('');
  });

  it('exitFor maps every status', () => {
    expect(['clear', 'resolved', 'answered'].map(exitFor)).toEqual([0, 0, 0]);
    expect(exitFor('human_needed')).toBe(10);
    expect(exitFor('waiting')).toBe(11);
    expect(exitFor('check_found')).toBe(20);
    expect(['still_blocked', 'timed_out', 'cancelled', 'rescue_limited', 'failed', 'alert_failed'].map(exitFor)).toEqual([30, 30, 30, 30, 30, 30]);
    expect(EXIT).toEqual({ done: 0, humanNeeded: 10, waiting: 11, checkFound: 20, failed: 30, usage: 2 });
  });
});
