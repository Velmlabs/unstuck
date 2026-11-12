import { describe, it, expect } from 'vitest';
import { MemoryEventLog } from '../src/events';

describe('MemoryEventLog', () => {
  it('keeps events in order', () => {
    const log = new MemoryEventLog();
    log.append({ ts: 1, sessionId: 's', type: 'created' });
    log.append({ ts: 2, sessionId: 's', type: 'finished', data: { status: 'resolved' } });
    expect(log.events.map((e) => e.type)).toEqual(['created', 'finished']);
  });
});
