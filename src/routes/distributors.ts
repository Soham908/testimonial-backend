import { Router } from "express";
import { prisma } from "../db/prisma";
import { getPlaybackUrl } from "../services/s3";
import { localizeQuestion } from "../services/questions";

export const distributorsRouter = Router();

// The distributor's own profile - header/account screens on the frontend
// (name, phone) plus the internal-test-phase-only fields (business, city,
// years_as_distributor - see prisma/schema.prisma, no import/CRM-sync
// mechanism exists yet, these are hand-seeded test values only).
distributorsRouter.get("/distributors/me", async (req, res) => {
  const { distributor_id } = req.auth!;

  const distributor = await prisma.distributor.findUniqueOrThrow({
    where: { id: distributor_id },
    select: {
      id: true,
      name: true,
      phone: true,
      business: true,
      city: true,
      years_as_distributor: true,
    },
  });

  res.json({ distributor });
});

// The set of questions the app should ask this distributor, localized to
// their language_pref. Ordered by index; count and content vary per client
// (e.g. 5 for the internal test client, 7 for IFB) — nothing here assumes a
// fixed set.
distributorsRouter.get("/distributors/me/questions", async (req, res) => {
  const { distributor_id, client_id } = req.auth!;

  const distributor = await prisma.distributor.findUniqueOrThrow({
    where: { id: distributor_id },
    select: { language_pref: true },
  });

  const questions = await prisma.question.findMany({
    where: { client_id },
    orderBy: { index: "asc" },
  });

  // Optional override of the distributor's stored language_pref for this
  // call only - lets the app request a specific language (defaulting to
  // "en" today) ahead of a real in-app language selector, without needing
  // to write anything back to the distributor record. Falls through to
  // language_pref, same as an unsupported/missing value would, if omitted
  // or not a string.
  const languageOverride = typeof req.query.language === "string" ? req.query.language : undefined;
  const language = languageOverride ?? distributor.language_pref;

  const results = await Promise.all(
    questions.map(async (question) => {
      const { text, vo_key, talking_points } = localizeQuestion(question, language);
      return {
        id: question.id,
        index: question.index,
        is_branded: question.is_branded,
        text,
        talking_points,
        vo_playback_url: await getPlaybackUrl(vo_key),
        updated_at: question.updated_at,
      };
    }),
  );

  res.json({ questions: results });
});

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
