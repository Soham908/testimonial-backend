import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Prisma } from "@prisma/client";

const queryRawMock = vi.fn();
const segmentFindFirstMock = vi.fn();
const questionFindManyMock = vi.fn();
const getPlaybackUrlMock = vi.fn();

vi.mock("../src/db/prisma", () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    segment: { findFirst: (...args: unknown[]) => segmentFindFirstMock(...args) },
    question: { findMany: (...args: unknown[]) => questionFindManyMock(...args) },
  },
}));

vi.mock("../src/services/s3", () => ({
  getPlaybackUrl: (...args: unknown[]) => getPlaybackUrlMock(...args),
}));

const ORIGINAL_FLAG = process.env.ENABLE_DASHBOARD_ENDPOINTS;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_DASHBOARD_ENDPOINTS;
  else process.env.ENABLE_DASHBOARD_ENDPOINTS = ORIGINAL_FLAG;
});

// src/routes/dashboard.ts decides whether to register routes at
// module-import time based on config.ENABLE_DASHBOARD_ENDPOINTS, so
// exercising both states means a fresh module import per state.
async function loadDashboardRouter(enabled: boolean) {
  vi.resetModules();
  process.env.ENABLE_DASHBOARD_ENDPOINTS = enabled ? "true" : "false";
  const { dashboardRouter } = await import("../src/routes/dashboard");
  return dashboardRouter;
}

function appWith(router: express.Router, auth = { distributor_id: "d1", client_id: "c1" }) {
  const app = express();
  app.use((req, _res, next) => {
    req.auth = auth;
    next();
  });
  app.use(router);
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return app;
}

describe("dashboard routes (ENABLE_DASHBOARD_ENDPOINTS)", () => {
  beforeEach(() => {
    queryRawMock.mockReset();
    segmentFindFirstMock.mockReset();
    questionFindManyMock.mockReset();
    getPlaybackUrlMock.mockReset();
    getPlaybackUrlMock.mockResolvedValue("https://s3.example.com/signed-video-url");
  });

  it("is unreachable when the flag is off (default) - a plain 404, not 403", async () => {
    const dashboardRouter = await loadDashboardRouter(false);
    const res = await request(appWith(dashboardRouter)).get("/dashboard/summary");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("GET /dashboard/summary aggregates status/sentiment/language rows into counts and percentages when the flag is on", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    queryRawMock
      .mockResolvedValueOnce([{ status: "transcribed", count: 3n }, { status: "failed", count: 1n }])
      .mockResolvedValueOnce([{ question_index: 1, count: 3n, avg_sentiment_score: 0.6 }])
      .mockResolvedValueOnce([{ total: 3n, positive: 2n, negative: 0n, neutral: 1n }])
      .mockResolvedValueOnce([{ language: "hin", count: 2n }, { language: "eng", count: 1n }]);

    const res = await request(appWith(dashboardRouter)).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.total_responses).toBe(4);
    expect(res.body.completion).toEqual({
      completed: 3,
      rate: 0.75,
      by_status: { transcribed: 3, failed: 1 },
    });
    expect(res.body.sentiment_split.positive).toEqual({ count: 2, percentage: 66.7 });
    expect(res.body.language_mix).toEqual({
      total_transcribed: 3,
      languages: [
        { language: "hin", count: 2, percentage: 66.7 },
        { language: "eng", count: 1, percentage: 33.3 },
      ],
    });
    expect(res.body.average_sentiment_by_question).toEqual([
      { question_index: 1, count: 3, average_sentiment_score: 0.6 },
    ]);
  });

  it("GET /dashboard/highlights with no params returns everything for the client (200, question_index/theme null)", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    queryRawMock.mockResolvedValueOnce([]);

    const res = await request(appWith(dashboardRouter)).get("/dashboard/highlights");

    expect(res.status).toBe(200);
    expect(res.body.question_index).toBeNull();
    expect(res.body.theme).toBeNull();
    expect(res.body.highlights).toEqual([]);
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it("GET /dashboard/highlights rejects a malformed question_index (400, no query issued)", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    const res = await request(appWith(dashboardRouter)).get("/dashboard/highlights?question_index=not-a-number");

    expect(res.status).toBe(400);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("GET /dashboard/highlights accepts theme alone, with no question_index (200, filters by theme network-wide)", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    queryRawMock.mockResolvedValueOnce([]);

    const res = await request(appWith(dashboardRouter)).get("/dashboard/highlights?theme=teacher_impact");

    expect(res.status).toBe(200);
    expect(res.body.question_index).toBeNull();
    expect(res.body.theme).toBe("teacher_impact");
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it("GET /dashboard/wordcloud rejects a malformed question_index without querying", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    const res = await request(appWith(dashboardRouter)).get("/dashboard/wordcloud?question_index=not-a-number");

    expect(res.status).toBe(400);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("GET /dashboard/wordcloud with no question_index aggregates across every question network-wide", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    queryRawMock.mockResolvedValueOnce([{ text: "great teacher" }, { text: "great school" }]);

    const res = await request(appWith(dashboardRouter)).get("/dashboard/wordcloud");

    expect(res.status).toBe(200);
    expect(res.body.question_index).toBeNull();
    expect(res.body.transcript_count).toBe(2);
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it("GET /dashboard/highlights excludes moderation_flag rows via the query and returns segment_id/distributor_name/actionable_feedback/video_url", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    queryRawMock.mockResolvedValueOnce([
      {
        segment_id: "22222222-2222-2222-2222-222222222222",
        best_quote: "It really changed how I think.",
        highlight_score: 0.9,
        sentiment_score: 0.8,
        language: "en",
        distributor_name: "Ramesh Traders",
        actionable_feedback: "Wants a faster support response.",
        video_key: "clients/c1/distributors/d2/segments/2.mp4",
      },
    ]);

    const res = await request(appWith(dashboardRouter)).get("/dashboard/highlights?question_index=2");

    expect(res.status).toBe(200);
    expect(res.body.question_index).toBe(2);
    expect(res.body.theme).toBeNull();
    expect(res.body.highlights).toHaveLength(1);
    expect(res.body.highlights[0].segment_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(res.body.highlights[0].distributor_name).toBe("Ramesh Traders");
    expect(res.body.highlights[0].actionable_feedback).toBe("Wants a faster support response.");
    expect(res.body.highlights[0].video_url).toBe("https://s3.example.com/signed-video-url");
    expect(res.body.highlights[0].video_key).toBeUndefined();
    expect(getPlaybackUrlMock).toHaveBeenCalledWith("clients/c1/distributors/d2/segments/2.mp4");
  });

  it("GET /dashboard/highlights rejects a theme outside THEME_VALUES (400, no query issued)", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    const res = await request(appWith(dashboardRouter)).get(
      "/dashboard/highlights?question_index=2&theme=not_a_real_theme",
    );

    expect(res.status).toBe(400);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("GET /dashboard/highlights accepts question_index and theme together as an intersection", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    queryRawMock.mockResolvedValueOnce([]);

    const res = await request(appWith(dashboardRouter)).get(
      "/dashboard/highlights?question_index=2&theme=teacher_impact",
    );

    expect(res.status).toBe(200);
    expect(res.body.theme).toBe("teacher_impact");
    expect(res.body.highlights).toEqual([]);
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it("GET /dashboard/highlights rejects a teacher_contribution outside TEACHER_CONTRIBUTION_VALUES (400, no query issued)", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    const res = await request(appWith(dashboardRouter)).get(
      "/dashboard/highlights?teacher_contribution=not_a_real_value",
    );

    expect(res.status).toBe(400);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("GET /dashboard/highlights rejects a life_skill outside LIFE_SKILL_VALUES (400, no query issued)", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    const res = await request(appWith(dashboardRouter)).get("/dashboard/highlights?life_skill=not_a_real_skill");

    expect(res.status).toBe(400);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("GET /dashboard/highlights rejects a sentiment_category outside positive/neutral/negative (400, no query issued)", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    const res = await request(appWith(dashboardRouter)).get(
      "/dashboard/highlights?sentiment_category=mixed",
    );

    expect(res.status).toBe(400);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("GET /dashboard/highlights accepts all five filters together as their intersection", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    queryRawMock.mockResolvedValueOnce([]);

    const res = await request(appWith(dashboardRouter)).get(
      "/dashboard/highlights?question_index=2&theme=teacher_impact&teacher_contribution=mentorship&life_skill=communication&sentiment_category=positive",
    );

    expect(res.status).toBe(200);
    expect(res.body.question_index).toBe(2);
    expect(res.body.theme).toBe("teacher_impact");
    expect(res.body.teacher_contribution).toBe("mentorship");
    expect(res.body.life_skill).toBe("communication");
    expect(res.body.sentiment_category).toBe("positive");
    expect(res.body.highlights).toEqual([]);
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it("GET /dashboard/highlights echoes all optional filters as null when omitted", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    queryRawMock.mockResolvedValueOnce([]);

    const res = await request(appWith(dashboardRouter)).get("/dashboard/highlights");

    expect(res.status).toBe(200);
    expect(res.body.teacher_contribution).toBeNull();
    expect(res.body.life_skill).toBeNull();
    expect(res.body.sentiment_category).toBeNull();
  });

  it("GET /dashboard/response/:segment_id rejects a malformed segment_id (400, no query issued)", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    const res = await request(appWith(dashboardRouter)).get("/dashboard/response/not-a-uuid");

    expect(res.status).toBe(400);
    expect(segmentFindFirstMock).not.toHaveBeenCalled();
  });

  it("GET /dashboard/response/:segment_id returns 404 for a segment outside the caller's client (or nonexistent)", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    segmentFindFirstMock.mockResolvedValueOnce(null);

    const res = await request(appWith(dashboardRouter)).get(
      "/dashboard/response/11111111-1111-1111-1111-111111111111",
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "segment_not_found" });
  });

  it("GET /dashboard/response/:segment_id returns the full transcript + sentiment detail + video_url, scoped by client_id", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    segmentFindFirstMock.mockResolvedValueOnce({
      id: "11111111-1111-1111-1111-111111111111",
      question_index: 3,
      video_key: "clients/c1/distributors/d1/segments/3.mp4",
      transcript: { text: "Full transcript text.", language_detected: "en", language_probability: 0.99 },
      sentiment_result: {
        sentiment_score: new Prisma.Decimal(0.5),
        themes: ["teacher_impact"],
        emotional_tone: "heartfelt",
        summary: "A summary.",
        best_quote: "A quote.",
        is_relevant: true,
        moderation_flag: false,
        contains_profanity: false,
        contains_complaint: false,
        actionable_feedback: null,
        highlight_score: new Prisma.Decimal(0.6),
        extracted: { mentions_teacher: false, teacher_contribution: null, life_skills_mentioned: [] },
      },
    });

    const res = await request(appWith(dashboardRouter)).get(
      "/dashboard/response/11111111-1111-1111-1111-111111111111",
    );

    expect(res.status).toBe(200);
    expect(res.body.question_index).toBe(3);
    expect(res.body.video_url).toBe("https://s3.example.com/signed-video-url");
    expect(res.body.transcript.text).toBe("Full transcript text.");
    expect(res.body.sentiment.summary).toBe("A summary.");
    // Prisma Decimal serializes via toJSON() as a string ("0.5") unless
    // cast at the source - these must come back as real JS numbers, not
    // strings, or a numeric UI (e.g. a sentiment gauge) breaks downstream.
    expect(res.body.sentiment.sentiment_score).toBe(0.5);
    expect(typeof res.body.sentiment.sentiment_score).toBe("number");
    expect(res.body.sentiment.highlight_score).toBe(0.6);
    expect(typeof res.body.sentiment.highlight_score).toBe("number");
    expect(getPlaybackUrlMock).toHaveBeenCalledWith("clients/c1/distributors/d1/segments/3.mp4");
    expect(segmentFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "11111111-1111-1111-1111-111111111111", distributor: { client_id: "c1" } },
      }),
    );
  });

  it("GET /dashboard/response/:segment_id returns video_url: null and skips signing when moderation_flag is true", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    segmentFindFirstMock.mockResolvedValueOnce({
      id: "33333333-3333-3333-3333-333333333333",
      question_index: 1,
      video_key: "clients/c1/distributors/d1/segments/1.mp4",
      transcript: { text: "Flagged transcript text.", language_detected: "en", language_probability: 0.9 },
      sentiment_result: {
        sentiment_score: new Prisma.Decimal(-0.8),
        themes: [],
        emotional_tone: "other",
        summary: "A summary.",
        best_quote: "A quote.",
        is_relevant: true,
        moderation_flag: true,
        contains_profanity: true,
        contains_complaint: false,
        actionable_feedback: null,
        highlight_score: new Prisma.Decimal(0.1),
        extracted: { mentions_teacher: false, teacher_contribution: null, life_skills_mentioned: [] },
      },
    });

    const res = await request(appWith(dashboardRouter)).get(
      "/dashboard/response/33333333-3333-3333-3333-333333333333",
    );

    expect(res.status).toBe(200);
    expect(res.body.video_url).toBeNull();
    expect(getPlaybackUrlMock).not.toHaveBeenCalled();
  });

  it("GET /dashboard/life-skills counts segments per skill in extracted.life_skills_mentioned", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    queryRawMock
      .mockResolvedValueOnce([{ total: 10n }])
      .mockResolvedValueOnce([
        { life_skill: "communication", count: 6n },
        { life_skill: "teamwork", count: 3n },
      ]);

    const res = await request(appWith(dashboardRouter)).get("/dashboard/life-skills");

    expect(res.status).toBe(200);
    expect(res.body.total_analyzed).toBe(10);
    expect(res.body.life_skills).toEqual([
      { life_skill: "communication", count: 6, percentage: 60 },
      { life_skill: "teamwork", count: 3, percentage: 30 },
    ]);
  });

  it("GET /dashboard/life-skills returns an empty breakdown when nothing has been analyzed", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    queryRawMock.mockResolvedValueOnce([{ total: 0n }]).mockResolvedValueOnce([]);

    const res = await request(appWith(dashboardRouter)).get("/dashboard/life-skills");

    expect(res.status).toBe(200);
    expect(res.body.total_analyzed).toBe(0);
    expect(res.body.life_skills).toEqual([]);
  });

  it("GET /dashboard/questions returns index + per-language text, scoped by client_id", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    questionFindManyMock.mockResolvedValueOnce([
      { index: 1, text_en: "English one?", text_hi: "Hindi one?", text_mr: "Marathi one?" },
      { index: 2, text_en: "English two?", text_hi: "Hindi two?", text_mr: "Marathi two?" },
    ]);

    const res = await request(appWith(dashboardRouter)).get("/dashboard/questions");

    expect(res.status).toBe(200);
    expect(res.body.questions).toEqual([
      { index: 1, text: { en: "English one?", hi: "Hindi one?", mr: "Marathi one?" } },
      { index: 2, text: { en: "English two?", hi: "Hindi two?", mr: "Marathi two?" } },
    ]);
    expect(questionFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { client_id: "c1" } }),
    );
  });
});
