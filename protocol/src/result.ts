export type TakeoverStatus = 'resolved' | 'timed_out' | 'cancelled' | 'failed';

export interface TakeoverResult {
  status: TakeoverStatus;
  sessionId: string;
  url: string;
  durationS: number;
  detail?: string;
}
