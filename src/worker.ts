import { prisma } from "./db/prisma";
import type { JobRow } from "./jobs/types";
import { transcribeSegmentHandler } from "./jobs/transcribeSegment";

type JobHandler = (job: JobRow) => Promise<void>;

// render_segment handler lands in build step 7.
const handlers: Partial<Record<string, JobHandler>> = {
  transcribe_segment: transcribeSegmentHandler,
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

async function processJob(job: JobRow): Promise<void> {
  console.log(`[${WORKER_ID}] claimed job ${job.id} (${job.type})`);

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
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: "failed",
        attempts: { increment: 1 },
        last_error: err instanceof Error ? err.message : String(err),
      },
    });
    console.error(`[${WORKER_ID}] job ${job.id} failed:`, err);
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
