import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EventLog, UnstuckEvent } from '@velmlabs/unstuck-core';

export function defaultLogPath(env: Record<string, string | undefined> = process.env): string {
  return env.UNSTUCK_LOG || path.join(os.homedir(), '.unstuck', 'events.jsonl');
}

/** Appends audit events as JSON lines. Logging must never break a takeover, so write errors are swallowed. */
export class JsonlFileEventLog implements EventLog {
  private dirReady = false;
  constructor(private readonly file: string) {}

  append(e: UnstuckEvent): void {
    try {
      if (!this.dirReady) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this.dirReady = true;
      }
      fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
    } catch {
      // ignore: audit logging is best-effort
    }
  }
}
