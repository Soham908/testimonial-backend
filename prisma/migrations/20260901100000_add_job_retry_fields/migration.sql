-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "jobs" ADD COLUMN "run_after" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "jobs" ADD COLUMN "lock_token" UUID;

-- CreateIndex
CREATE INDEX "jobs_status_run_after_idx" ON "jobs"("status", "run_after");
