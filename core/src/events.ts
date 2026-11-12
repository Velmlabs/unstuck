export type UnstuckEventType = 'created' | 'published' | 'link' | 'viewer_joined' | 'viewer_left' | 'viewer_rejected' | 'status' | 'finished';

/** Structured audit event. Never contains screenshots, typed text or secrets: only counts and states. */
export interface UnstuckEvent {
  ts: number;
  sessionId: string;
  type: UnstuckEventType;
  data?: Record<string, string | number | boolean>;
}

export interface EventLog {
  append(e: UnstuckEvent): void;
}

export class MemoryEventLog implements EventLog {
  readonly events: UnstuckEvent[] = [];
  append(e: UnstuckEvent): void {
    this.events.push(e);
  }
}
