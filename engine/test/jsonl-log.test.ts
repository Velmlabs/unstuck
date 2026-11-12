import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlFileEventLog, defaultLogPath } from '../src/jsonl-log';

describe('JsonlFileEventLog', () => {
  it('appends one parseable JSON line per event, creating the directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-log-'));
    const file = path.join(dir, 'nested', 'events.jsonl');
    const log = new JsonlFileEventLog(file);
    log.append({ ts: 1, sessionId: 's', type: 'created' });
    log.append({ ts: 2, sessionId: 's', type: 'finished', data: { status: 'resolved' } });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['created', 'finished']);
  });

  it('never throws if the file cannot be written', () => {
    const notADir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'unstuck-log-')), 'file');
    fs.writeFileSync(notADir, 'x');
    const log = new JsonlFileEventLog(path.join(notADir, 'sub', 'events.jsonl'));
    expect(() => log.append({ ts: 1, sessionId: 's', type: 'created' })).not.toThrow();
  });

  it('defaultLogPath prefers UNSTUCK_LOG, else ~/.unstuck/events.jsonl', () => {
    expect(defaultLogPath({ UNSTUCK_LOG: '/tmp/x.jsonl' })).toBe('/tmp/x.jsonl');
    expect(defaultLogPath({})).toBe(path.join(os.homedir(), '.unstuck', 'events.jsonl'));
  });
});
