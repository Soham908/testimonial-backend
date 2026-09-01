export type JobRow = {
  id: string;
  type: string;
  payload: unknown;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  lock_token: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};
