import { prisma } from "./db/prisma";
import type { JobRow } from "./jobs/types";
import { transcribeSegmentHandler } from "./jobs/transcribeSegment";
import { renderSegmentHandler } from "./jobs/renderSegment";

type JobHandler = (job: JobRow) => Promise<void>;

const handlers: Partial<Record<string, JobHandler>> = {
  transcribe_segment: transcribeSegmentHandler,
  render_segment: renderSegmentHandler,
};

const POLL_INTERVAL_MS = 1000;
const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;

async function claimJob(): Promise<JobRow | null> {
  const rows = await prisma.$queryRaw<JobRow[]>`
    UPDATE "jobs"
    SET "status" = 'processing', "updated_at" = now()
    WHERE "id" = (
      SELECT "id" FROM "jobs"
      WHERE "status" = 'pending'
      ORDER BY "created_at"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `;
  return rows[0] ?? null;
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

async function processJob(job: JobRow): Promise<void> {
  console.log(`[${WORKER_ID}] claimed job ${job.id} (${job.type}) payload=${JSON.stringify(job.payload)}`);

  try {
    const handler = handlers[job.type];
    if (handler) {
      await handler(job);
    }

    await prisma.job.update({
      where: { id: job.id },
      data: { status: "done" },
    });
    console.log(`[${WORKER_ID}] completed job ${job.id}`);
  } catch (err) {
    const detail = formatError(err);
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "failed",
        attempts: { increment: 1 },
        last_error: detail,
      },
    });
    console.error(`[${WORKER_ID}] job ${job.id} (${job.type}) failed: ${detail}`);
  }
}

async function pollLoop(): Promise<void> {
  const job = await claimJob();
  if (job) {
    await processJob(job);
    setImmediate(pollLoop);
  } else {
    setTimeout(pollLoop, POLL_INTERVAL_MS);
  }
}

console.log(`[${WORKER_ID}] worker started`);
pollLoop();
