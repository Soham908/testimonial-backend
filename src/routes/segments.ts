import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { buildSegmentVideoKey, getUploadUrl, objectExists } from "../services/s3";

export const segmentsRouter = Router();

// Well-formedness only — whether this index actually has a question
// configured for the caller's client is checked separately against the
// questions table, since the count/content varies per client (5 for the
// internal test client, 7 for IFB) rather than being a fixed global range.
function isPlausibleQuestionIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

async function questionExists(client_id: string, question_index: number): Promise<boolean> {
  const question = await prisma.question.findUnique({
    where: { client_id_index: { client_id, index: question_index } },
    select: { id: true },
  });
  return question !== null;
}

// What the device actually captured (file size, resolution, fps, codec,
// device model/OS version) - stored as-is for later analysis, not
// validated field-by-field. Best-effort and optional: a missing or
// malformed `capture` never fails the confirm call, since this only
// exists at capture time and nothing downstream depends on it today.
function normalizeCaptureMetadata(value: unknown): Prisma.InputJsonValue | undefined {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Prisma.InputJsonValue;
}

// Absolute offsets (ms) into the source clip, chosen in Review & Trim.
// `undefined` (field omitted entirely) means "the client didn't send a
// trim opinion at all" - leaves whatever's already on the segment alone,
// same as `capture` above. `null` is a real, meaningful value distinct
// from that - "the person looked at the trim UI and kept the full clip" -
// and must be written as null, not skipped.
function isValidTrimMs(value: unknown): value is number | null | undefined {
  if (value === undefined || value === null) return true;
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

segmentsRouter.post("/segments/upload-url", async (req, res) => {
  const { question_index } = req.body ?? {};

  if (!isPlausibleQuestionIndex(question_index)) {
    res.status(400).json({ error: "question_index must be a positive integer" });
    return;
  }

  const { distributor_id, client_id } = req.auth!;

  if (!(await questionExists(client_id, question_index))) {
    res.status(400).json({ error: `No question configured at index ${question_index} for this client` });
    return;
  }

  const video_key = buildSegmentVideoKey(client_id, distributor_id, question_index);
  const upload_url = await getUploadUrl(video_key);

  console.log(
    `[segments] upload-url issued distributor=${distributor_id} question_index=${question_index} video_key=${video_key}`,
  );

  res.json({ upload_url, video_key });
});

segmentsRouter.post("/segments/confirm", async (req, res) => {
  const { question_index, duration, trim_start_ms, trim_end_ms, capture } = req.body ?? {};

  if (!isPlausibleQuestionIndex(question_index)) {
    res.status(400).json({ error: "question_index must be a positive integer" });
    return;
  }
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    res.status(400).json({ error: "duration must be a positive number" });
    return;
  }
  if (!isValidTrimMs(trim_start_ms) || !isValidTrimMs(trim_end_ms)) {
    res.status(400).json({ error: "trim_start_ms/trim_end_ms must be a non-negative number or null" });
    return;
  }
  if (typeof trim_start_ms === "number" && typeof trim_end_ms === "number" && trim_end_ms <= trim_start_ms) {
    res.status(400).json({ error: "trim_end_ms must be greater than trim_start_ms" });
    return;
  }

  const { distributor_id, client_id } = req.auth!;

  if (!(await questionExists(client_id, question_index))) {
    res.status(400).json({ error: `No question configured at index ${question_index} for this client` });
    return;
  }

  // Derived server-side from the caller's own auth-scoped ids, never taken
  // from the request body — the client-supplied video_key used to be trusted
  // as-is, and since keys are fully predictable
  // (clients/{client_id}/distributors/{distributor_id}/segments/{n}.mp4), a
  // caller could otherwise confirm a key belonging to another distributor's
  // real upload and have it recorded as their own segment.
  const video_key = buildSegmentVideoKey(client_id, distributor_id, question_index);
  const duration_seconds = Math.round(duration);
  const capture_metadata = normalizeCaptureMetadata(capture);
  const trim_start = trim_start_ms === undefined ? undefined : typeof trim_start_ms === "number" ? Math.round(trim_start_ms) : null;
  const trim_end = trim_end_ms === undefined ? undefined : typeof trim_end_ms === "number" ? Math.round(trim_end_ms) : null;

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
      update: {
        video_key,
        duration_seconds,
        status: "uploaded",
        ...(trim_start !== undefined && { trim_start_ms: trim_start }),
        ...(trim_end !== undefined && { trim_end_ms: trim_end }),
        ...(capture_metadata !== undefined && { capture_metadata }),
      },
      create: {
        distributor_id,
        question_index,
        video_key,
        duration_seconds,
        status: "uploaded",
        ...(trim_start !== undefined && { trim_start_ms: trim_start }),
        ...(trim_end !== undefined && { trim_end_ms: trim_end }),
        ...(capture_metadata !== undefined && { capture_metadata }),
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
