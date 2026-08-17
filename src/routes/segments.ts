import { Router } from "express";
import { prisma } from "../db/prisma";
import { buildSegmentVideoKey, getUploadUrl, objectExists } from "../services/s3";

export const segmentsRouter = Router();

function isValidQuestionIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

segmentsRouter.post("/segments/upload-url", async (req, res) => {
  const { question_index } = req.body ?? {};

  if (!isValidQuestionIndex(question_index)) {
    res.status(400).json({ error: "question_index must be an integer between 1 and 5" });
    return;
  }

  const { distributor_id, client_id } = req.auth!;
  const video_key = buildSegmentVideoKey(client_id, distributor_id, question_index);
  const upload_url = await getUploadUrl(video_key);

  console.log(
    `[segments] upload-url issued distributor=${distributor_id} question_index=${question_index} video_key=${video_key}`,
  );

  res.json({ upload_url, video_key });
});

segmentsRouter.post("/segments/confirm", async (req, res) => {
  const { question_index, duration } = req.body ?? {};

  if (!isValidQuestionIndex(question_index)) {
    res.status(400).json({ error: "question_index must be an integer between 1 and 5" });
    return;
  }
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    res.status(400).json({ error: "duration must be a positive number" });
    return;
  }

  const { distributor_id, client_id } = req.auth!;
  // Derived server-side from the caller's own auth-scoped ids, never taken
  // from the request body — the client-supplied video_key used to be trusted
  // as-is, and since keys are fully predictable
  // (clients/{client_id}/distributors/{distributor_id}/segments/{n}.mp4), a
  // caller could otherwise confirm a key belonging to another distributor's
  // real upload and have it recorded as their own segment.
  const video_key = buildSegmentVideoKey(client_id, distributor_id, question_index);
  const duration_seconds = Math.round(duration);

  if (!(await objectExists(video_key))) {
    console.warn(
      `[segments] confirm rejected: video_not_found distributor=${distributor_id} question_index=${question_index} video_key=${video_key}`,
    );
    res.status(404).json({
      error: "video_not_found",
      message: "The uploaded video could not be found in storage. Please retry the upload.",
    });
    return;
  }

  const segment = await prisma.$transaction(async (tx) => {
    const seg = await tx.segment.upsert({
      where: { distributor_id_question_index: { distributor_id, question_index } },
      update: { video_key, duration_seconds, status: "uploaded" },
      create: {
        distributor_id,
        question_index,
        video_key,
        duration_seconds,
        status: "uploaded",
      },
    });

    // render_segment isn't queued here — it depends on the captioned video
    // transcribe_segment produces, so transcribe_segment queues it once that's
    // ready (see src/jobs/transcribeSegment.ts).
    await tx.job.create({
      data: { type: "transcribe_segment", payload: { segment_id: seg.id } },
    });

    return seg;
  });

  console.log(
    `[segments] confirm received distributor=${distributor_id} question_index=${question_index} segment=${segment.id} — queued transcribe_segment`,
  );

  res.json({ segment });
});

// Temporary test-only endpoint for inspecting sentiment analysis output.
// Scoped by client_id (not distributor_id) since this is company/admin data,
// never the distributor's own — matches the same boundary GET
// /distributors/me/segments must respect once it exists (step 8). This isn't
// part of the documented API surface in backend-plan.html; the real version
// is that doc's GET /clients/:id/insights (Phase 7, needs admin auth that
// doesn't exist yet in Phase A).
segmentsRouter.get("/segments/sentiment", async (req, res) => {
  const { client_id } = req.auth!;

  const segments = await prisma.segment.findMany({
    where: { distributor: { client_id }, sentiment_result: { isNot: null } },
    select: {
      id: true,
      question_index: true,
      distributor: { select: { name: true } },
      sentiment_result: {
        select: {
          sentiment_score: true,
          themes: true,
          summary: true,
          best_quote: true,
          is_relevant: true,
          moderation_flag: true,
          contains_complaint: true,
          actionable_feedback: true,
          highlight_score: true,
          created_at: true,
        },
      },
    },
  });

  res.json({ results: segments });
});
