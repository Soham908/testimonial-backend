import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const queryRawMock = vi.fn();
const segmentFindFirstMock = vi.fn();

vi.mock("../src/db/prisma", () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRawMock(...args),
    segment: { findFirst: (...args: unknown[]) => segmentFindFirstMock(...args) },
  },
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
  });

  it("is unreachable when the flag is off (default) - a plain 404, not 403", async () => {
    const dashboardRouter = await loadDashboardRouter(false);
    const res = await request(appWith(dashboardRouter)).get("/dashboard/summary");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("GET /dashboard/summary aggregates status/sentiment rows into counts and percentages when the flag is on", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    queryRawMock
      .mockResolvedValueOnce([{ status: "transcribed", count: 3n }, { status: "failed", count: 1n }])
      .mockResolvedValueOnce([{ question_index: 1, count: 3n, avg_sentiment_score: 0.6 }])
      .mockResolvedValueOnce([{ total: 3n, positive: 2n, negative: 0n, neutral: 1n }]);

    const res = await request(appWith(dashboardRouter)).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.total_responses).toBe(4);
    expect(res.body.completion).toEqual({
      completed: 3,
      rate: 0.75,
      by_status: { transcribed: 3, failed: 1 },
    });
    expect(res.body.sentiment_split.positive).toEqual({ count: 2, percentage: 66.7 });
    expect(res.body.average_sentiment_by_question).toEqual([
      { question_index: 1, count: 3, average_sentiment_score: 0.6 },
    ]);
  });

  it("GET /dashboard/highlights requires question_index (400, no query issued)", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    const res = await request(appWith(dashboardRouter)).get("/dashboard/highlights");

    expect(res.status).toBe(400);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("GET /dashboard/wordcloud rejects a malformed question_index without querying", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    const res = await request(appWith(dashboardRouter)).get("/dashboard/wordcloud?question_index=not-a-number");

    expect(res.status).toBe(400);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("GET /dashboard/highlights excludes moderation_flag rows via the query and returns segment_id/distributor_name/actionable_feedback", async () => {
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
      },
    ]);

    const res = await request(appWith(dashboardRouter)).get("/dashboard/highlights?question_index=2");

    expect(res.status).toBe(200);
    expect(res.body.question_index).toBe(2);
    expect(res.body.highlights).toHaveLength(1);
    expect(res.body.highlights[0].segment_id).toBe("22222222-2222-2222-2222-222222222222");
    expect(res.body.highlights[0].distributor_name).toBe("Ramesh Traders");
    expect(res.body.highlights[0].actionable_feedback).toBe("Wants a faster support response.");
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

  it("GET /dashboard/response/:segment_id returns the full transcript + sentiment detail, scoped by client_id", async () => {
    const dashboardRouter = await loadDashboardRouter(true);
    segmentFindFirstMock.mockResolvedValueOnce({
      id: "11111111-1111-1111-1111-111111111111",
      question_index: 3,
      transcript: { text: "Full transcript text.", language_detected: "en", language_probability: 0.99 },
      sentiment_result: {
        sentiment_score: 0.5,
        themes: ["teacher_impact"],
        emotional_tone: "heartfelt",
        summary: "A summary.",
        best_quote: "A quote.",
        is_relevant: true,
        moderation_flag: false,
        contains_profanity: false,
        contains_complaint: false,
        actionable_feedback: null,
        highlight_score: 0.6,
        extracted: { mentions_teacher: false, teacher_contribution: null, life_skills_mentioned: [] },
      },
    });

    const res = await request(appWith(dashboardRouter)).get(
      "/dashboard/response/11111111-1111-1111-1111-111111111111",
    );

    expect(res.status).toBe(200);
    expect(res.body.question_index).toBe(3);
    expect(res.body.transcript.text).toBe("Full transcript text.");
    expect(res.body.sentiment.summary).toBe("A summary.");
    expect(segmentFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "11111111-1111-1111-1111-111111111111", distributor: { client_id: "c1" } },
      }),
    );
  });
});
