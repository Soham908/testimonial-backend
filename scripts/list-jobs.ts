// Lists jobs in failed or stuck state without opening a DB client - the
// same three categories the retry/reaper logic in src/worker.ts cares
// about. Run with `npm run jobs:list`.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Mirrors config.JOB_VISIBILITY_TIMEOUT_MS's default (src/config/env.ts) -
// duplicated here rather than imported since this script runs standalone
// via tsx, without the rest of the app's config/env validation.
const JOB_VISIBILITY_TIMEOUT_MS = Number(process.env.JOB_VISIBILITY_TIMEOUT_MS) || 15 * 60 * 1000;

function fmt(job: {
  id: string;
  type: string;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  updated_at: Date;
  last_error: string | null;
  payload: unknown;
}): string {
  const payload = JSON.stringify(job.payload);
  return `  ${job.id}  ${job.type}  attempt ${job.attempts}/${job.max_attempts}  payload=${payload}\n    last_error: ${job.last_error ?? "(none)"}`;
}

async function main() {
  const failed = await prisma.job.findMany({
    where: { status: "failed" },
    orderBy: { updated_at: "desc" },
  });

  const cutoff = new Date(Date.now() - JOB_VISIBILITY_TIMEOUT_MS);
  const stuck = await prisma.job.findMany({
    where: { status: "processing", updated_at: { lt: cutoff } },
    orderBy: { updated_at: "asc" },
  });

  const retrying = await prisma.job.findMany({
    where: { status: "pending", attempts: { gt: 0 } },
    orderBy: { run_after: "asc" },
  });

  console.log(`\n=== Terminal failed (${failed.length}) ===`);
  failed.forEach((j) => console.log(fmt(j)));

  console.log(`\n=== Stuck in processing past visibility timeout (${JOB_VISIBILITY_TIMEOUT_MS}ms) - will be reclaimed by the next worker poll (${stuck.length}) ===`);
  stuck.forEach((j) => console.log(fmt(j)));

  console.log(`\n=== Backing off, waiting to retry (${retrying.length}) ===`);
  retrying.forEach((j) =>
    console.log(`${fmt(j)}\n    next attempt at: ${j.run_after.toISOString()}`),
  );

  console.log("");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
