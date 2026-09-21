import { Router } from "express";
import { prisma } from "../db/prisma";
import { config } from "../config/env";
import { computeWordFrequency } from "../services/wordFrequency";
import { THEME_VALUES, type Theme } from "../services/gemini";
import { getPlaybackUrl } from "../services/s3";

// Internal/admin dashboard endpoints — the real surface for sentiment_results
// data (see CLAUDE.md's "admin dashboard was forgotten from scope" note;
// supersedes the old test-only GET /segments/sentiment, since removed).
// Gated behind its own ENABLE_DASHBOARD_ENDPOINTS (default off, route not
// registered at all when off — see src/config/env.ts for why), scoped by
// client_id (not distributor_id) since this is internal/company data no
// single distributor should see about themselves or others, and a stand-in
// for backend-plan.html's Phase 7 GET /clients/:id/insights until real
// admin auth exists.
//
// Every route here is read-only and SQL-aggregated — no LLM call, no write.
export const dashboardRouter = Router();

// sentiment_score thresholds used to bucket the "sentiment split" in
// GET /dashboard/summary — a fixed, documented cutoff (see API_CONTRACT.md),
// not derived from the data.
const POSITIVE_THRESHOLD = 0.3;
const NEGATIVE_THRESHOLD = -0.3;

// highlight_score thresholds used to bucket the distribution in
// GET /dashboard/extraction-quality — see API_CONTRACT.md.
const HIGHLIGHT_HIGH_THRESHOLD = 0.85;
const HIGHLIGHT_MID_THRESHOLD = 0.4;

const DEFAULT_WORDCLOUD_LIMIT = 100;
const MAX_WORDCLOUD_LIMIT = 500;
const DEFAULT_HIGHLIGHTS_LIMIT = 10;
const MAX_HIGHLIGHTS_LIMIT = 50;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// undefined = param absent (caller didn't filter), null = present but not a
// well-formed positive integer (caller should get a 400), number = valid.
function parseOptionalQuestionIndex(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

// undefined = param absent, null = present but not one of THEME_VALUES
// (caller should get a 400), Theme = valid.
function parseOptionalTheme(raw: unknown): Theme | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !(THEME_VALUES as readonly string[]).includes(raw)) return null;
  return raw as Theme;
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== "string") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

function percentage(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
}

if (config.ENABLE_DASHBOARD_ENDPOINTS) {
  // GET /dashboard/wordcloud?question_index=N&limit=100
  // Tokenizes and counts words across transcripts for this client (all
  // questions, or one question when question_index is given). Code-only, no
  // LLM — see src/services/wordFrequency.ts for the English/Hindi/Marathi
  // stopword handling.
  dashboardRouter.get("/dashboard/wordcloud", async (req, res) => {
    const { client_id } = req.auth!;
    const question_index = parseOptionalQuestionIndex(req.query.question_index);
    if (question_index === null) {
      res.status(400).json({ error: "question_index must be a positive integer" });
      return;
    }
    const limit = parseLimit(req.query.limit, DEFAULT_WORDCLOUD_LIMIT, MAX_WORDCLOUD_LIMIT);

    const rows = await prisma.$queryRaw<Array<{ text: string }>>`
      SELECT t."text"
      FROM "transcripts" t
      JOIN "segments" s ON s."id" = t."segment_id"
      JOIN "distributors" d ON d."id" = s."distributor_id"
      WHERE d."client_id" = ${client_id}::uuid
        AND (${question_index ?? null}::int IS NULL OR s."question_index" = ${question_index ?? null}::int)
    `;

    const words = computeWordFrequency(
      rows.map((r) => r.text),
      limit,
    );

    res.json({ question_index: question_index ?? null, transcript_count: rows.length, words });
  });

  // GET /dashboard/summary
  // language_mix: a real network-wide rollup of Transcript.language_detected
  // (the same raw ElevenLabs code already exposed per-segment on
  // GET /dashboard/response/:segment_id and per-row on
  // GET /dashboard/highlights — e.g. "hin", not "hi"; no relabeling here).
  // Denominated against total_transcribed (segments with a transcript row),
  // not total_responses — a segment with no transcript has no
  // language_detected value at all, same reasoning as sentiment_split being
  // denominated against total_analyzed rather than total_responses.
  dashboardRouter.get("/dashboard/summary", async (req, res) => {
    const { client_id } = req.auth!;

    const statusRows = await prisma.$queryRaw<Array<{ status: string; count: bigint }>>`
      SELECT s."status"::text AS status, COUNT(*)::bigint AS count
      FROM "segments" s
      JOIN "distributors" d ON d."id" = s."distributor_id"
      WHERE d."client_id" = ${client_id}::uuid
      GROUP BY s."status"
    `;
    const by_status = Object.fromEntries(statusRows.map((r) => [r.status, Number(r.count)]));
    const total_responses = statusRows.reduce((sum, r) => sum + Number(r.count), 0);
    const completed = by_status["transcribed"] ?? 0;

    const sentimentRows = await prisma.$queryRaw<
      Array<{ question_index: number; count: bigint; avg_sentiment_score: number | null }>
    >`
      SELECT s."question_index" AS question_index, COUNT(*)::bigint AS count,
             AVG(sr."sentiment_score")::float AS avg_sentiment_score
      FROM "sentiment_results" sr
      JOIN "segments" s ON s."id" = sr."segment_id"
      JOIN "distributors" d ON d."id" = s."distributor_id"
      WHERE d."client_id" = ${client_id}::uuid
      GROUP BY s."question_index"
      ORDER BY s."question_index"
    `;

    const splitRow = await prisma.$queryRaw<
      Array<{ total: bigint; positive: bigint; negative: bigint; neutral: bigint }>
    >`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE sr."sentiment_score" >= ${POSITIVE_THRESHOLD})::bigint AS positive,
        COUNT(*) FILTER (WHERE sr."sentiment_score" <= ${NEGATIVE_THRESHOLD})::bigint AS negative,
        COUNT(*) FILTER (
          WHERE sr."sentiment_score" > ${NEGATIVE_THRESHOLD} AND sr."sentiment_score" < ${POSITIVE_THRESHOLD}
        )::bigint AS neutral
      FROM "sentiment_results" sr
      JOIN "segments" s ON s."id" = sr."segment_id"
      JOIN "distributors" d ON d."id" = s."distributor_id"
      WHERE d."client_id" = ${client_id}::uuid
    `;
    const split = splitRow[0] ?? { total: 0n, positive: 0n, negative: 0n, neutral: 0n };
    const total_analyzed = Number(split.total);

    const languageRows = await prisma.$queryRaw<Array<{ language: string; count: bigint }>>`
      SELECT t."language_detected" AS language, COUNT(*)::bigint AS count
      FROM "transcripts" t
      JOIN "segments" s ON s."id" = t."segment_id"
      JOIN "distributors" d ON d."id" = s."distributor_id"
      WHERE d."client_id" = ${client_id}::uuid
      GROUP BY t."language_detected"
      ORDER BY count DESC
    `;
    const total_transcribed = languageRows.reduce((sum, r) => sum + Number(r.count), 0);

    res.json({
      total_responses,
      completion: {
        completed,
        rate: percentage(completed, total_responses) / 100,
        by_status,
      },
      sentiment_split: {
        total_analyzed,
        thresholds: { positive: `>= ${POSITIVE_THRESHOLD}`, negative: `<= ${NEGATIVE_THRESHOLD}` },
        positive: { count: Number(split.positive), percentage: percentage(Number(split.positive), total_analyzed) },
        neutral: { count: Number(split.neutral), percentage: percentage(Number(split.neutral), total_analyzed) },
        negative: { count: Number(split.negative), percentage: percentage(Number(split.negative), total_analyzed) },
      },
      language_mix: {
        total_transcribed,
        languages: languageRows.map((r) => ({
          language: r.language,
          count: Number(r.count),
          percentage: percentage(Number(r.count), total_transcribed),
        })),
      },
      average_sentiment_by_question: sentimentRows.map((r) => ({
        question_index: r.question_index,
        count: Number(r.count),
        average_sentiment_score: r.avg_sentiment_score,
      })),
    });
  });

  // GET /dashboard/themes
  dashboardRouter.get("/dashboard/themes", async (req, res) => {
    const { client_id } = req.auth!;

    const [themeRows, complaintThemeRows] = await Promise.all([
      prisma.$queryRaw<Array<{ theme: string; count: bigint }>>`
        SELECT theme, COUNT(*)::bigint AS count
        FROM "sentiment_results" sr
        JOIN "segments" s ON s."id" = sr."segment_id"
        JOIN "distributors" d ON d."id" = s."distributor_id"
        CROSS JOIN LATERAL jsonb_array_elements_text(sr."themes") AS theme
        WHERE d."client_id" = ${client_id}::uuid
        GROUP BY theme
        ORDER BY count DESC
      `,
      prisma.$queryRaw<Array<{ theme: string; count: bigint }>>`
        SELECT theme, COUNT(*)::bigint AS count
        FROM "sentiment_results" sr
        JOIN "segments" s ON s."id" = sr."segment_id"
        JOIN "distributors" d ON d."id" = s."distributor_id"
        CROSS JOIN LATERAL jsonb_array_elements_text(sr."themes") AS theme
        WHERE d."client_id" = ${client_id}::uuid AND sr."contains_complaint" = true
        GROUP BY theme
        ORDER BY count DESC
      `,
    ]);

    res.json({
      themes: themeRows.map((r) => ({ theme: r.theme, count: Number(r.count) })),
      themes_with_complaint: complaintThemeRows.map((r) => ({ theme: r.theme, count: Number(r.count) })),
    });
  });

  // GET /dashboard/theme-sentiment
  dashboardRouter.get("/dashboard/theme-sentiment", async (req, res) => {
    const { client_id } = req.auth!;

    const rows = await prisma.$queryRaw<Array<{ theme: string; count: bigint; avg_sentiment_score: number }>>`
      SELECT theme, COUNT(*)::bigint AS count, AVG(sr."sentiment_score")::float AS avg_sentiment_score
      FROM "sentiment_results" sr
      JOIN "segments" s ON s."id" = sr."segment_id"
      JOIN "distributors" d ON d."id" = s."distributor_id"
      CROSS JOIN LATERAL jsonb_array_elements_text(sr."themes") AS theme
      WHERE d."client_id" = ${client_id}::uuid
      GROUP BY theme
      ORDER BY count DESC
    `;

    res.json({
      themes: rows.map((r) => ({ theme: r.theme, count: Number(r.count), average_sentiment_score: r.avg_sentiment_score })),
    });
  });

  // GET /dashboard/highlights?question_index=N&theme=<theme_name>&limit=10
  // Excludes moderation_flag: true segments — this endpoint surfaces
  // quotable highlights, which is exactly the "unsuitable for external use"
  // bar moderation_flag encodes (see src/services/gemini.ts).
  //
  // Includes segment_id — lets the UI link a highlight through to
  // GET /dashboard/response/:segment_id's detail drawer.
  //
  // Includes video_url per item (added 2026-09-21) — same signed-URL
  // generation as GET /dashboard/response/:segment_id (getPlaybackUrl,
  // fresh every request, 1hr expiry), so a grid of several video
  // thumbnails doesn't need one request per item. No separate
  // moderation_flag null-out needed here the way the single-lookup
  // endpoint has one: this endpoint's WHERE clause already excludes every
  // moderation_flag: true row before it ever reaches this point, so every
  // row video_url is generated for is already guaranteed unflagged.
  //
  // question_index and theme are both independent, optional filters —
  // omitting both returns highlights across the whole client; question_index
  // alone scopes to one question; theme alone (one of THEME_VALUES, 400
  // otherwise) scopes to a theme regardless of question; both together is
  // the intersection. Previously question_index was required even when only
  // theme was given (a bare ?theme=X 400'd) — that coupling was never the
  // intent (see Step 9b) and forced callers wanting "evidence for this
  // theme" to fan out one request per question_index and merge client-side.
  // This is what makes every theme-based panel (barlists, treemap blocks,
  // ring stats, sentiment-by-theme rows) clickable through to real evidence
  // via the same drawer with a single request, without a new endpoint or
  // new extraction — the theme data already exists on
  // sentiment_results.themes, this just filters on it.
  //
  // Includes distributor_name and actionable_feedback — a deliberate,
  // endpoint-specific reversal of the rest of this router's "no identity"
  // design. This dashboard is viewed only internally (two known people),
  // never published to IFB or any external audience, and most dry-run
  // participants are staff/friends/family the viewers already know
  // personally, so withholding the name here serves no real purpose.
  // KEEP THIS INTERNAL-ONLY: do not carry name exposure into any future
  // client-facing version of this endpoint (or a new one) without a fresh
  // decision at that point — this reasoning does not automatically extend
  // to a client-facing dashboard.
  dashboardRouter.get("/dashboard/highlights", async (req, res) => {
    const { client_id } = req.auth!;
    const question_index = parseOptionalQuestionIndex(req.query.question_index);
    if (question_index === null) {
      res.status(400).json({ error: "question_index must be a positive integer" });
      return;
    }
    const theme = parseOptionalTheme(req.query.theme);
    if (theme === null) {
      res.status(400).json({ error: `theme must be one of: ${THEME_VALUES.join(", ")}` });
      return;
    }
    const limit = parseLimit(req.query.limit, DEFAULT_HIGHLIGHTS_LIMIT, MAX_HIGHLIGHTS_LIMIT);

    const rows = await prisma.$queryRaw<
      Array<{
        segment_id: string;
        best_quote: string;
        highlight_score: number;
        sentiment_score: number;
        language: string | null;
        distributor_name: string;
        actionable_feedback: string | null;
        video_key: string;
      }>
    >`
      SELECT sr."segment_id" AS segment_id, sr."best_quote" AS best_quote,
             sr."highlight_score"::float AS highlight_score,
             sr."sentiment_score"::float AS sentiment_score, t."language_detected" AS language,
             d."name" AS distributor_name, sr."actionable_feedback" AS actionable_feedback,
             s."video_key" AS video_key
      FROM "sentiment_results" sr
      JOIN "segments" s ON s."id" = sr."segment_id"
      JOIN "distributors" d ON d."id" = s."distributor_id"
      JOIN "transcripts" t ON t."segment_id" = s."id"
      WHERE d."client_id" = ${client_id}::uuid
        AND (${question_index ?? null}::int IS NULL OR s."question_index" = ${question_index ?? null}::int)
        AND sr."moderation_flag" = false
        AND (
          ${theme ?? null}::text IS NULL
          OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(sr."themes") AS theme_value
            WHERE theme_value = ${theme ?? null}
          )
        )
      ORDER BY sr."highlight_score" DESC
      LIMIT ${limit}
    `;

    const highlights = await Promise.all(
      rows.map(async ({ video_key, ...row }) => ({ ...row, video_url: await getPlaybackUrl(video_key) })),
    );

    res.json({ question_index: question_index ?? null, theme: theme ?? null, highlights });
  });

  // GET /dashboard/response/:segment_id
  // Single-segment lookup, not a list — full transcript text + the complete
  // sentiment_result record, for drilling into one individual response's
  // full detail from the UI (e.g. clicking through from /dashboard/
  // highlights or /dashboard/wordcloud). Returns null for `transcript`/
  // `sentiment` if that stage hasn't completed yet, rather than 404 —
  // only a segment_id that doesn't belong to this client at all is a 404.
  //
  // video_url: a short-lived signed S3 GET URL for the segment's own
  // video_key — the same file/key already used during upload/confirm,
  // nothing new stored. Reuses getPlaybackUrl (same helper the mobile app's
  // My Videos playback uses), generated fresh on every request, never
  // cached. Internal-only, same reasoning as distributor_name on
  // /dashboard/highlights above — do not carry into any future
  // client-facing version without a fresh decision at that point.
  // null when moderation_flag is true: a flagged segment can still count
  // toward aggregate numbers elsewhere, but its individual video should not
  // be individually surfaced, even internally, same as its quote is already
  // excluded from /dashboard/highlights.
  dashboardRouter.get("/dashboard/response/:segment_id", async (req, res) => {
    const { client_id } = req.auth!;
    const { segment_id } = req.params;

    if (!UUID_PATTERN.test(segment_id)) {
      res.status(400).json({ error: "segment_id must be a valid UUID" });
      return;
    }

    const segment = await prisma.segment.findFirst({
      where: { id: segment_id, distributor: { client_id } },
      select: {
        id: true,
        question_index: true,
        video_key: true,
        transcript: {
          select: { text: true, language_detected: true, language_probability: true },
        },
        sentiment_result: {
          select: {
            sentiment_score: true,
            themes: true,
            emotional_tone: true,
            summary: true,
            best_quote: true,
            is_relevant: true,
            moderation_flag: true,
            contains_profanity: true,
            contains_complaint: true,
            actionable_feedback: true,
            highlight_score: true,
            extracted: true,
          },
        },
      },
    });

    if (!segment) {
      res.status(404).json({ error: "segment_not_found" });
      return;
    }

    const moderationFlagged = segment.sentiment_result?.moderation_flag === true;
    const video_url = moderationFlagged ? null : await getPlaybackUrl(segment.video_key);

    // sentiment_score/highlight_score are Prisma Decimal here (this is a
    // plain model query, not $queryRaw with an explicit ::float cast like
    // every other endpoint in this file uses) - Decimal.toJSON() returns a
    // string, so res.json() below would otherwise silently send "0.6"
    // instead of 0.6. Cast at the source rather than leaving it to whatever
    // consumes this response to coerce.
    const sentiment = segment.sentiment_result
      ? {
          ...segment.sentiment_result,
          sentiment_score: segment.sentiment_result.sentiment_score.toNumber(),
          highlight_score: segment.sentiment_result.highlight_score.toNumber(),
        }
      : null;

    res.json({
      segment_id: segment.id,
      question_index: segment.question_index,
      video_url,
      transcript: segment.transcript,
      sentiment,
    });
  });

  // GET /dashboard/questions
  // Per-client question list (index + text in every language) — labeled
  // data for the UI to build a real question picker from, instead of a
  // bare "type a question number" input. Not localized to one language
  // like GET /distributors/me/questions is (that endpoint is for the
  // recording app, picks one language for the distributor); this one
  // returns all three so the dashboard can label regardless of which
  // language a given response happens to be in.
  dashboardRouter.get("/dashboard/questions", async (req, res) => {
    const { client_id } = req.auth!;

    const questions = await prisma.question.findMany({
      where: { client_id },
      orderBy: { index: "asc" },
      select: { index: true, text_en: true, text_hi: true, text_mr: true },
    });

    res.json({
      questions: questions.map((q) => ({
        index: q.index,
        text: { en: q.text_en, hi: q.text_hi, mr: q.text_mr },
      })),
    });
  });

  // GET /dashboard/teacher-impact
  dashboardRouter.get("/dashboard/teacher-impact", async (req, res) => {
    const { client_id } = req.auth!;

    const totalsRow = await prisma.$queryRaw<Array<{ total: bigint; mentions_teacher: bigint }>>`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE (sr."extracted"->>'mentions_teacher')::boolean = true)::bigint AS mentions_teacher
      FROM "sentiment_results" sr
      JOIN "segments" s ON s."id" = sr."segment_id"
      JOIN "distributors" d ON d."id" = s."distributor_id"
      WHERE d."client_id" = ${client_id}::uuid
    `;
    const totals = totalsRow[0] ?? { total: 0n, mentions_teacher: 0n };
    const total_analyzed = Number(totals.total);
    const mentions_teacher_count = Number(totals.mentions_teacher);

    const contributionRows = await prisma.$queryRaw<Array<{ teacher_contribution: string; count: bigint }>>`
      SELECT sr."extracted"->>'teacher_contribution' AS teacher_contribution, COUNT(*)::bigint AS count
      FROM "sentiment_results" sr
      JOIN "segments" s ON s."id" = sr."segment_id"
      JOIN "distributors" d ON d."id" = s."distributor_id"
      WHERE d."client_id" = ${client_id}::uuid
        AND (sr."extracted"->>'mentions_teacher')::boolean = true
      GROUP BY teacher_contribution
      ORDER BY count DESC
    `;

    res.json({
      total_analyzed,
      mentions_teacher: { count: mentions_teacher_count, percentage: percentage(mentions_teacher_count, total_analyzed) },
      teacher_contribution: contributionRows.map((r) => ({
        teacher_contribution: r.teacher_contribution,
        count: Number(r.count),
        percentage: percentage(Number(r.count), mentions_teacher_count),
      })),
    });
  });

  // GET /dashboard/life-skills — count of segments per life skill mentioned
  // (extracted.life_skills_mentioned), across the 5 real skills enforced by
  // Gemini's structured-output schema (LIFE_SKILL_VALUES,
  // src/services/gemini.ts). Same shape/denominator convention as
  // GET /dashboard/teacher-impact's contribution breakdown just above, and
  // its own endpoint for the same reason teacher-impact is its own endpoint
  // rather than folded into GET /dashboard/summary — this is its own
  // analytical dimension, not a top-line number. Only populated for
  // segments analyzed after the 2026-09-16 prompt rewrite
  // (extracted.life_skills_mentioned didn't exist in that shape before).
  // Unlike mentions_teacher/teacher_contribution, there's no gating boolean
  // here — a segment can mention 0, 1, or several skills, so counts don't
  // sum to total_analyzed and percentages are each independently of
  // total_analyzed, not of each other.
  dashboardRouter.get("/dashboard/life-skills", async (req, res) => {
    const { client_id } = req.auth!;

    const totalsRow = await prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*)::bigint AS total
      FROM "sentiment_results" sr
      JOIN "segments" s ON s."id" = sr."segment_id"
      JOIN "distributors" d ON d."id" = s."distributor_id"
      WHERE d."client_id" = ${client_id}::uuid
    `;
    const total_analyzed = Number(totalsRow[0]?.total ?? 0n);

    const skillRows = await prisma.$queryRaw<Array<{ life_skill: string; count: bigint }>>`
      SELECT skill AS life_skill, COUNT(*)::bigint AS count
      FROM "sentiment_results" sr
      JOIN "segments" s ON s."id" = sr."segment_id"
      JOIN "distributors" d ON d."id" = s."distributor_id"
      CROSS JOIN LATERAL jsonb_array_elements_text(sr."extracted"->'life_skills_mentioned') AS skill
      WHERE d."client_id" = ${client_id}::uuid
      GROUP BY skill
      ORDER BY count DESC
    `;

    res.json({
      total_analyzed,
      life_skills: skillRows.map((r) => ({
        life_skill: r.life_skill,
        count: Number(r.count),
        percentage: percentage(Number(r.count), total_analyzed),
      })),
    });
  });

  // GET /dashboard/technical — internal/QA use (device mix, resolution mix,
  // average recording length), not participant-facing content.
  dashboardRouter.get("/dashboard/technical", async (req, res) => {
    const { client_id } = req.auth!;

    const [deviceRows, resolutionRows, durationRows] = await Promise.all([
      prisma.$queryRaw<Array<{ device_model: string | null; os_version: string | null; count: bigint }>>`
        SELECT s."capture_metadata"->>'device_model' AS device_model,
               s."capture_metadata"->>'os_version' AS os_version,
               COUNT(*)::bigint AS count
        FROM "segments" s
        JOIN "distributors" d ON d."id" = s."distributor_id"
        WHERE d."client_id" = ${client_id}::uuid AND s."capture_metadata" IS NOT NULL
        GROUP BY device_model, os_version
        ORDER BY count DESC
      `,
      prisma.$queryRaw<Array<{ width: string | null; height: string | null; count: bigint }>>`
        SELECT s."capture_metadata"->>'width' AS width, s."capture_metadata"->>'height' AS height,
               COUNT(*)::bigint AS count
        FROM "segments" s
        JOIN "distributors" d ON d."id" = s."distributor_id"
        WHERE d."client_id" = ${client_id}::uuid AND s."capture_metadata" IS NOT NULL
        GROUP BY width, height
        ORDER BY count DESC
      `,
      prisma.$queryRaw<Array<{ question_index: number; avg_duration_seconds: number; count: bigint }>>`
        SELECT s."question_index" AS question_index, AVG(s."duration_seconds")::float AS avg_duration_seconds,
               COUNT(*)::bigint AS count
        FROM "segments" s
        JOIN "distributors" d ON d."id" = s."distributor_id"
        WHERE d."client_id" = ${client_id}::uuid
        GROUP BY s."question_index"
        ORDER BY s."question_index"
      `,
    ]);

    res.json({
      devices: deviceRows.map((r) => ({
        device_model: r.device_model,
        os_version: r.os_version,
        count: Number(r.count),
      })),
      resolutions: resolutionRows.map((r) => ({
        width: r.width === null ? null : Number(r.width),
        height: r.height === null ? null : Number(r.height),
        count: Number(r.count),
      })),
      average_duration_by_question: durationRows.map((r) => ({
        question_index: r.question_index,
        average_duration_seconds: r.avg_duration_seconds,
        count: Number(r.count),
      })),
    });
  });

  // GET /dashboard/extraction-quality — a meta-view of the pipeline itself
  // (is_relevant rate, highlight_score distribution, contains_profanity
  // rate), not the testimonial content.
  dashboardRouter.get("/dashboard/extraction-quality", async (req, res) => {
    const { client_id } = req.auth!;

    const row = await prisma.$queryRaw<
      Array<{
        total: bigint;
        relevant: bigint;
        profanity_known: bigint;
        profanity_true: bigint;
        highlight_high: bigint;
        highlight_mid: bigint;
        highlight_low: bigint;
      }>
    >`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE sr."is_relevant" = true)::bigint AS relevant,
        COUNT(*) FILTER (WHERE sr."contains_profanity" IS NOT NULL)::bigint AS profanity_known,
        COUNT(*) FILTER (WHERE sr."contains_profanity" = true)::bigint AS profanity_true,
        COUNT(*) FILTER (WHERE sr."highlight_score" >= ${HIGHLIGHT_HIGH_THRESHOLD})::bigint AS highlight_high,
        COUNT(*) FILTER (
          WHERE sr."highlight_score" >= ${HIGHLIGHT_MID_THRESHOLD} AND sr."highlight_score" < ${HIGHLIGHT_HIGH_THRESHOLD}
        )::bigint AS highlight_mid,
        COUNT(*) FILTER (WHERE sr."highlight_score" < ${HIGHLIGHT_MID_THRESHOLD})::bigint AS highlight_low
      FROM "sentiment_results" sr
      JOIN "segments" s ON s."id" = sr."segment_id"
      JOIN "distributors" d ON d."id" = s."distributor_id"
      WHERE d."client_id" = ${client_id}::uuid
    `;
    const r = row[0] ?? {
      total: 0n,
      relevant: 0n,
      profanity_known: 0n,
      profanity_true: 0n,
      highlight_high: 0n,
      highlight_mid: 0n,
      highlight_low: 0n,
    };
    const total_analyzed = Number(r.total);
    const profanity_known_count = Number(r.profanity_known);

    res.json({
      total_analyzed,
      is_relevant: {
        count: Number(r.relevant),
        percentage: percentage(Number(r.relevant), total_analyzed),
      },
      contains_profanity: {
        // known_count excludes rows written before this column existed
        // (nullable — see prisma/schema.prisma) so the rate isn't diluted
        // by segments that were never actually checked for profanity.
        known_count: profanity_known_count,
        count: Number(r.profanity_true),
        percentage: percentage(Number(r.profanity_true), profanity_known_count),
      },
      highlight_score_distribution: {
        thresholds: { high: `>= ${HIGHLIGHT_HIGH_THRESHOLD}`, mid: `>= ${HIGHLIGHT_MID_THRESHOLD}`, low: `< ${HIGHLIGHT_MID_THRESHOLD}` },
        high: { count: Number(r.highlight_high), percentage: percentage(Number(r.highlight_high), total_analyzed) },
        mid: { count: Number(r.highlight_mid), percentage: percentage(Number(r.highlight_mid), total_analyzed) },
        low: { count: Number(r.highlight_low), percentage: percentage(Number(r.highlight_low), total_analyzed) },
      },
    });
  });
}
