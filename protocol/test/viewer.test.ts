import { describe, it, expect } from 'vitest';
import { parseViewerMessage, ViewerToEngineSchema, EngineToViewerSchema } from '../src/viewer';
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
