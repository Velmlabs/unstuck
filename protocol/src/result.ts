export type TakeoverStatus = 'resolved' | 'timed_out' | 'cancelled' | 'failed';

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
}
