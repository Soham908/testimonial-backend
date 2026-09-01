import { randomUUID } from "node:crypto";
import { prisma } from "./db/prisma";
import { config } from "./config/env";
import type { JobRow } from "./jobs/types";
import { transcribeSegmentHandler } from "./jobs/transcribeSegment";
import { renderSegmentHandler } from "./jobs/renderSegment";

type JobHandler = (job: JobRow) => Promise<void>;

// Exported so tests can substitute a handler without needing the real
// transcribe/render side effects (S3, ffmpeg, ElevenLabs, Gemini,
// nexrender-cloud) - see tests/worker.test.ts.
export const handlers: Partial<Record<string, JobHandler>> = {
  transcribe_segment: transcribeSegmentHandler,
  render_segment: renderSegmentHandler,
};

const POLL_INTERVAL_MS = 1000;
const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;

// Exponential backoff between requeue attempts, capped so a persistently
// failing job (e.g. nexrender-cloud down) doesn't end up retried once every
// few seconds while it works through its max_attempts ceiling.
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60 * 1000;

export function backoffDelayMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
}

// Single atomic UPDATE (subquery + FOR UPDATE SKIP LOCKED), same pattern as
// before this change — only the WHERE clause (run_after) and a fresh
// lock_token are new. A job only becomes claimable once run_after <= now(),
// which is how retry backoff actually delays a requeued job rather than
// just marking time on a row nothing reads.
export async function claimJob(): Promise<JobRow | null> {
  const lockToken = randomUUID();
  const rows = await prisma.$queryRaw<JobRow[]>`
    UPDATE "jobs"
    SET "status" = 'processing', "updated_at" = now(), "lock_token" = ${lockToken}::uuid
    WHERE "id" = (
      SELECT "id" FROM "jobs"
      WHERE "status" = 'pending' AND "run_after" <= now()
      ORDER BY "created_at"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  return rows[0] ?? null;
}

// Visibility timeout: a job left in `processing` longer than
// JOB_VISIBILITY_TIMEOUT_MS is assumed abandoned (its worker crashed or was
// killed before it could report success or failure) and reclaimed here,
// exactly like an in-process failure would be — same attempts/backoff/
// terminal-failed logic, just triggered by staleness instead of a thrown
// error. Reclaims (at most) one stale job per call; called once per poll
// tick, so a pile-up of several stuck jobs drains over the next few ticks
// rather than all at once.
//
// Concurrency guard: the `updated_at` in the WHERE clause below is an
// optimistic-concurrency check against the exact row this call just read.
// If another worker's reaper (or the original worker finally reporting
// back) touched the row in between, updateMany matches zero rows and this
// call quietly does nothing — no double-reclaim of the same stuck job.
export async function reapStuckJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - config.JOB_VISIBILITY_TIMEOUT_MS);
  const stale = await prisma.job.findFirst({
    where: { status: "processing", updated_at: { lt: cutoff } },
    orderBy: { updated_at: "asc" },
  });
  if (!stale) return;

  const attempts = stale.attempts + 1;
  const terminal = attempts >= stale.max_attempts;
  const detail = `Reclaimed after exceeding visibility timeout (${config.JOB_VISIBILITY_TIMEOUT_MS}ms) - original worker did not report success or failure, likely crashed or was killed mid-job.`;

  const result = await prisma.job.updateMany({
    where: { id: stale.id, status: "processing", updated_at: stale.updated_at },
    data: {
      attempts,
      status: terminal ? "failed" : "pending",
      run_after: terminal ? stale.run_after : new Date(Date.now() + backoffDelayMs(attempts)),
      last_error: detail,
      lock_token: null,
    },
  });
  if (result.count === 0) {
    return;
  }
  console.warn(
    `[reaper] reclaimed stuck job ${stale.id} (${stale.type}), attempt ${attempts}/${stale.max_attempts} -> ${
      terminal ? "failed (terminal)" : "pending (retry after backoff)"
    }`,
  );
}

// execFile-based errors (ffmpeg) carry the real failure reason on .stderr/.code/
// .signal rather than always folding it into .message — capture those explicitly
// so a bare "Command failed: ffmpeg ..." with no detail never happens again.
function formatError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  const anyErr = err as Error & { stderr?: string; code?: number | string; signal?: string };
  const parts = [anyErr.message];
  if (anyErr.stderr) parts.push(`stderr: ${anyErr.stderr}`);
  if (anyErr.code !== undefined) parts.push(`exit code: ${anyErr.code}`);
  if (anyErr.signal) parts.push(`signal: ${anyErr.signal}`);
  return parts.join(" | ");
}

// Every write-back to this job row (done / retry / terminal-fail) is
// conditioned on lock_token still matching what claimJob handed us. If the
// reaper reclaimed this job out from under us (we were slow, not dead - the
// handler kept running past the visibility timeout and only just returned
// or threw), the token on the row has already changed and this matches
// zero rows: we log and stop, we don't clobber whoever holds the job now.
// This only guards the job row's bookkeeping - it does not itself prevent
// the handler from having run twice. That's covered by transcribeSegment.ts
// and renderSegment.ts each checking for already-completed work (existing
// transcript/captioned-video/sentiment/render) before doing anything, so a
// genuine double-run is a safe no-op rather than a duplicate record.
export async function processJob(job: JobRow): Promise<void> {
  console.log(
    `[${WORKER_ID}] claimed job ${job.id} (${job.type}) attempt=${job.attempts + 1}/${job.max_attempts} payload=${JSON.stringify(job.payload)}`,
  );

  try {
    const handler = handlers[job.type];
    if (handler) {
      await handler(job);
    }

    const result = await prisma.job.updateMany({
      where: { id: job.id, lock_token: job.lock_token },
      data: { status: "done" },
    });
    if (result.count === 0) {
      console.warn(`[${WORKER_ID}] job ${job.id} finished but its lock was reclaimed - not marking done`);
      return;
    }
    console.log(`[${WORKER_ID}] completed job ${job.id}`);
  } catch (err) {
    const detail = formatError(err);
    const attempts = job.attempts + 1;
    const terminal = attempts >= job.max_attempts;

    const result = await prisma.job.updateMany({
      where: { id: job.id, lock_token: job.lock_token },
      data: {
        attempts,
        status: terminal ? "failed" : "pending",
        run_after: terminal ? job.run_after : new Date(Date.now() + backoffDelayMs(attempts)),
        last_error: detail,
        lock_token: null,
      },
    });
    if (result.count === 0) {
      console.warn(`[${WORKER_ID}] job ${job.id} failed but its lock was reclaimed - not updating`);
      return;
    }
    console.error(
      `[${WORKER_ID}] job ${job.id} (${job.type}) failed, attempt ${attempts}/${job.max_attempts}${
        terminal ? " - terminal" : ` - retrying in ${backoffDelayMs(attempts)}ms`
      }: ${detail}`,
    );
  }
}

async function pollLoop(): Promise<void> {
  await reapStuckJobs();
  const job = await claimJob();
  if (job) {
    await processJob(job);
    setImmediate(pollLoop);
  } else {
    setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
}

// This module has no import-time side effects (no auto-started loop) so it
// can be safely imported by tests and one-off scripts without also kicking
// off a real polling worker. `require.main === module` is the usual guard
// for this, but proved unreliable under this project's tsx setup - it
// still fired from a non-entrypoint import during testing. Splitting the
// actual start call into src/worker-main.ts (the only file that calls this)
// sidesteps that entirely instead of relying on entrypoint detection.
export function startWorker(): void {
  console.log(`[${WORKER_ID}] worker started`);
  pollLoop();
}
