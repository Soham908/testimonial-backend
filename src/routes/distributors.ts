import { Router } from "express";
import { prisma } from "../db/prisma";
import { getPlaybackUrl } from "../services/s3";

export const distributorsRouter = Router();

distributorsRouter.get("/distributors/me/segments", async (req, res) => {
  const { distributor_id } = req.auth!;

  const segments = await prisma.segment.findMany({
    where: { distributor_id },
    orderBy: { question_index: "asc" },
  });

  const results = await Promise.all(
    segments.map(async (segment) => ({
      question_index: segment.question_index,
      status: segment.status,
      playback_url: await getPlaybackUrl(segment.video_key),
      duration_seconds: segment.duration_seconds,
      created_at: segment.created_at,
      updated_at: segment.updated_at,
    })),
  );

  res.json({ segments: results });
});

// One reel per question (CLAUDE.md's locked decision), so this returns an
// array keyed by question_index — not the single object backend-plan.html's
// wording implies, which was written before that decision's schema
// consequence (rendered_videos keyed on segment_id) was fully carried through.
distributorsRouter.get("/distributors/me/rendered-videos", async (req, res) => {
  const { distributor_id } = req.auth!;

  const rendered = await prisma.renderedVideo.findMany({
    where: { segment: { distributor_id } },
    include: { segment: { select: { question_index: true } } },
    orderBy: { segment: { question_index: "asc" } },
  });

  const results = await Promise.all(
    rendered.map(async (video) => ({
      question_index: video.segment.question_index,
      status: video.status,
      // The row's video_key is known (and set) as soon as nexrender accepts
      // the job, before the file actually exists in S3 — only safe to hand
      // out a playback URL once status is "rendered".
      playback_url: video.status === "rendered" ? await getPlaybackUrl(video.video_key) : null,
      updated_at: video.updated_at,
    })),
  );

  res.json({ rendered_videos: results });
});
