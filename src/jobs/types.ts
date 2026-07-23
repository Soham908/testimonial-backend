export type JobRow = {
  id: string;
  type: string;
  payload: unknown;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};
