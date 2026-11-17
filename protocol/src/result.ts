export type TakeoverStatus = 'resolved' | 'answered' | 'timed_out' | 'cancelled' | 'failed';

/** What the person answered to a question: the chosen option (index and label) and/or typed text. */
export interface AskAnswer {
  choice?: number;
  label?: string;
  text?: string;
}

export interface TakeoverResult {
  status: TakeoverStatus;
  sessionId: string;
  url: string;
  durationS: number;
  /**
   * Why it ended, when there is more to say: e.g. `page_closed`, `viewer_left`, `engine_closed`, `alert_failed` (with
   * `alerts: 'required'`, the link reached no paired phone), or the human's own words after Can't solve.
   */
  detail?: string;
  /** The person's answer, when the status is `answered`. */
  answer?: AskAnswer;
  /** Where the answer came from. */
  via?: 'page' | 'telegram';
}

export interface AskResult {
  status: 'answered' | 'timed_out' | 'cancelled' | 'failed';
  answer?: AskAnswer;
  via?: 'page' | 'telegram';
  durationS: number;
  sessionId: string;
  detail?: string;
}
