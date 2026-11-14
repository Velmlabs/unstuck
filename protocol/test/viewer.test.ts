import { describe, it, expect } from 'vitest';
import { parseViewerMessage, ViewerToEngineSchema, EngineToViewerSchema, FieldKinds } from '../src/viewer';
import { Value } from '@sinclair/typebox/value';

describe('parseViewerMessage', () => {
  it('accepts a valid mouse message', () => {
    const raw = '{"t":"mouse","action":"down","x":1,"y":2,"button":"left","clickCount":1,"modifiers":0}';
    expect(parseViewerMessage(raw)).toEqual({ t: 'mouse', action: 'down', x: 1, y: 2, button: 'left', clickCount: 1, modifiers: 0 });
  });

  it.each([
    ['{"t":"hello","token":"abc"}'],
    ['{"t":"hello","token":"abc","resumeKey":"r"}'],
    ['{"t":"wheel","x":1,"y":2,"dx":0,"dy":-3}'],
    ['{"t":"key","action":"up","key":"a","code":"KeyA","modifiers":0}'],
    ['{"t":"text","text":"héllo 日本"}'],
    ['{"t":"done"}'],
    ['{"t":"cant_solve"}'],
    ['{"t":"cant_solve","reason":"blurry"}'],
    ['{"t":"ping"}'],
  ])('accepts %s', (raw) => {
    expect(parseViewerMessage(raw)).toEqual(JSON.parse(raw));
  });

  it.each([['{"t":"mouse"}'], ['not json'], ['{"t":"eval","code":"x"}'], ['null'], ['{"t":"text","text":5}']])(
    'rejects %s',
    (raw) => {
      expect(parseViewerMessage(raw)).toBeNull();
    },
  );
});

describe('EngineToViewerSchema', () => {
  it('accepts ready, state, error and pong', () => {
    for (const m of [
      { t: 'ready', reason: 'r', site: 's', expiresAt: 1, resumeKey: 'k' },
      { t: 'state', status: 'resolved' },
      { t: 'error', code: 'token_used', message: 'm' },
      { t: 'pong' },
    ]) expect(Value.Check(EngineToViewerSchema, m)).toBe(true);
  });

  it('rejects unknown statuses', () => {
    expect(Value.Check(EngineToViewerSchema, { t: 'state', status: 'weird' })).toBe(false);
  });

  it('is a distinct schema from viewer-to-engine', () => {
    expect(Value.Check(ViewerToEngineSchema, { t: 'pong' })).toBe(false);
  });
});

describe('six-digit code', () => {
  it('hello accepts a 6-digit code only', () => {
    expect(parseViewerMessage('{"t":"hello","token":"a","code":"123456"}')).not.toBeNull();
    expect(parseViewerMessage('{"t":"hello","token":"a","code":"12345"}')).toBeNull();
    expect(parseViewerMessage('{"t":"hello","token":"a","code":"abcdef"}')).toBeNull();
  });
  it('error codes include code_required and code_invalid', async () => {
    const { ViewerErrorCodes } = await import('../src/viewer');
    expect(ViewerErrorCodes).toContain('code_required');
    expect(ViewerErrorCodes).toContain('code_invalid');
  });
});

describe('native typing messages', () => {
  const field = { x: 1, y: 2, w: 3, h: 4, kind: 'otp' as const };
  it('accepts a field map and focus reports', () => {
    expect(Value.Check(EngineToViewerSchema, { t: 'fields', fields: [field] })).toBe(true);
    expect(Value.Check(EngineToViewerSchema, { t: 'fields', fields: [] })).toBe(true);
    expect(Value.Check(EngineToViewerSchema, { t: 'focus', kind: null })).toBe(true);
    expect(Value.Check(EngineToViewerSchema, { t: 'focus', kind: 'email' })).toBe(true);
  });
  it('rejects unknown kinds, extra keys (never a value) and more than 30 fields', () => {
    expect(Value.Check(EngineToViewerSchema, { t: 'fields', fields: [{ ...field, kind: 'date' }] })).toBe(false);
    expect(Value.Check(EngineToViewerSchema, { t: 'fields', fields: [{ ...field, value: '482913' }] })).toBe(false);
    expect(Value.Check(EngineToViewerSchema, { t: 'fields', fields: Array.from({ length: 31 }, () => field) })).toBe(false);
    expect(Value.Check(EngineToViewerSchema, { t: 'focus', kind: 'date' })).toBe(false);
  });
  it('lists the five field kinds', () => {
    expect(FieldKinds).toEqual(['text', 'numeric', 'otp', 'email', 'password']);
  });
});
