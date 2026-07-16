-- CreateEnum
CREATE TYPE "SegmentStatus" AS ENUM ('recorded_local', 'uploaded', 'transcribing', 'transcribed', 'failed');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('transcribe_segment', 'render_segment');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('pending', 'processing', 'done', 'failed');

-- CreateEnum
CREATE TYPE "RenderedVideoStatus" AS ENUM ('pending', 'rendering', 'rendered', 'failed');

-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "branding_config" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distributors" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "invite_token" TEXT NOT NULL,
    "language_pref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "distributors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" UUID NOT NULL,
    "distributor_id" UUID NOT NULL,
    "question_index" INTEGER NOT NULL,
    "video_key" TEXT NOT NULL,
    "status" "SegmentStatus" NOT NULL DEFAULT 'recorded_local',
    "duration_seconds" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "language_detected" TEXT NOT NULL,
    "srt_key" TEXT NOT NULL,
    "vtt_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sentiment_results" (
    "id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "sentiment_score" DECIMAL(65,30) NOT NULL,
    "themes" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sentiment_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "type" "JobType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rendered_videos" (
    "id" UUID NOT NULL,
    "segment_id" UUID NOT NULL,
    "video_key" TEXT NOT NULL,
    "status" "RenderedVideoStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "rendered_videos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "distributors_invite_token_key" ON "distributors"("invite_token");

-- CreateIndex
CREATE UNIQUE INDEX "segments_distributor_id_question_index_key" ON "segments"("distributor_id", "question_index");

-- CreateIndex
CREATE UNIQUE INDEX "transcripts_segment_id_key" ON "transcripts"("segment_id");

-- CreateIndex
CREATE UNIQUE INDEX "sentiment_results_segment_id_key" ON "sentiment_results"("segment_id");

-- CreateIndex
CREATE UNIQUE INDEX "rendered_videos_segment_id_key" ON "rendered_videos"("segment_id");

-- AddForeignKey
ALTER TABLE "distributors" ADD CONSTRAINT "distributors_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_distributor_id_fkey" FOREIGN KEY ("distributor_id") REFERENCES "distributors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sentiment_results" ADD CONSTRAINT "sentiment_results_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rendered_videos" ADD CONSTRAINT "rendered_videos_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
