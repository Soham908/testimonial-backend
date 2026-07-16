import { Router } from "express";
import { prisma } from "../db/prisma";
import { buildSegmentVideoKey, getUploadUrl } from "../services/s3";

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

  res.json({ upload_url, video_key });
});

segmentsRouter.post("/segments/confirm", async (req, res) => {
  const { question_index, video_key, duration } = req.body ?? {};

  if (!isValidQuestionIndex(question_index)) {
    res.status(400).json({ error: "question_index must be an integer between 1 and 5" });
    return;
  }
  if (typeof video_key !== "string" || video_key.length === 0) {
    res.status(400).json({ error: "video_key is required" });
    return;
  }
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    res.status(400).json({ error: "duration is required" });
    return;
  }

  const { distributor_id } = req.auth!;

  const segment = await prisma.$transaction(async (tx) => {
    const seg = await tx.segment.upsert({
      where: { distributor_id_question_index: { distributor_id, question_index } },
      update: { video_key, duration_seconds: duration, status: "uploaded" },
      create: {
        distributor_id,
        question_index,
        video_key,
        duration_seconds: duration,
        status: "uploaded",
      },
    });

    await tx.job.createMany({
      data: [
        { type: "transcribe_segment", payload: { segment_id: seg.id } },
        { type: "render_segment", payload: { segment_id: seg.id } },
      ],
    });

    return seg;
  });

  res.json({ segment });
});
