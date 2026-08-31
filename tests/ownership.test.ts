import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// Two distributors under the same client - the exact shape the reported
// leak needs to reproduce (one client, multiple distributors, one asking
// for the other's data). IDs are arbitrary strings; the routes under test
// never parse them as UUIDs.
const CLIENT_ID = "client-1";
const DISTRIBUTOR_A = "distributor-a";
const DISTRIBUTOR_B = "distributor-b";

const SEGMENTS = [
  {
    id: "seg-a",
    distributor_id: DISTRIBUTOR_A,
    question_index: 1,
    status: "uploaded",
    video_key: "clients/client-1/distributors/distributor-a/segments/1.mp4",
    duration_seconds: 30,
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
  },
  {
    id: "seg-b",
    distributor_id: DISTRIBUTOR_B,
    question_index: 1,
    status: "uploaded",
    video_key: "clients/client-1/distributors/distributor-b/segments/1.mp4",
    duration_seconds: 45,
    created_at: new Date("2026-01-02"),
    updated_at: new Date("2026-01-02"),
  },
];

const RENDERED_VIDEOS = [
  {
    id: "rv-a",
    segment_id: "seg-a",
    video_key: "rendered/a.mp4",
    status: "rendered" as const,
    updated_at: new Date("2026-01-01"),
    segment: { question_index: 1, distributor_id: DISTRIBUTOR_A },
  },
  {
    id: "rv-b",
    segment_id: "seg-b",
    video_key: "rendered/b.mp4",
    status: "rendered" as const,
    updated_at: new Date("2026-01-02"),
    segment: { question_index: 1, distributor_id: DISTRIBUTOR_B },
  },
];

// A minimal fake that actually filters the fixture data by the `where`
// clause each route passes in - this is what makes the test meaningful: if
// a route were changed to filter by client_id instead of distributor_id (or
// dropped the filter entirely), `where.distributor_id` would be
// undefined/wrong and the filter below would return the wrong rows (or all
// of them), and the assertions on the HTTP response would catch it. This is
// not just asserting "findMany was called with the right args" - it proves
// the route only ever sees, and returns, the caller's own rows.
vi.mock("../src/db/prisma", () => ({
  prisma: {
    segment: {
      findMany: vi.fn(async ({ where }: { where: { distributor_id?: string } }) =>
        SEGMENTS.filter((s) => !where.distributor_id || s.distributor_id === where.distributor_id),
      ),
    },
    renderedVideo: {
      findMany: vi.fn(
        async ({ where }: { where: { segment?: { distributor_id?: string } } }) => {
          const wanted = where.segment?.distributor_id;
          return RENDERED_VIDEOS.filter((rv) => !wanted || rv.segment.distributor_id === wanted);
        },
      ),
    },
  },
}));

vi.mock("../src/services/s3", () => ({
  getPlaybackUrl: vi.fn(async (key: string) => `https://example.invalid/${key}`),
}));

const { distributorsRouter } = await import("../src/routes/distributors");

function appAs(auth: { distributor_id: string; client_id: string }) {
  const app = express();
  app.use((req, _res, next) => {
    req.auth = auth;
    next();
  });
  app.use(distributorsRouter);
  return app;
}

describe("GET /distributors/me/segments - ownership", () => {
  it("only returns the caller's own segment when another distributor's data exists in the same client", async () => {
    const res = await request(appAs({ distributor_id: DISTRIBUTOR_A, client_id: CLIENT_ID })).get(
      "/distributors/me/segments",
    );

    expect(res.status).toBe(200);
    expect(res.body.segments).toHaveLength(1);
    expect(res.body.segments[0].duration_seconds).toBe(30);
    // Distributor B's segment (45s) must never appear in A's response.
    expect(JSON.stringify(res.body)).not.toContain("distributor-b");
    expect(res.body.segments.every((s: { duration_seconds: number }) => s.duration_seconds !== 45)).toBe(true);
  });

  it("returns the other distributor's own segment when asked as them - confirms this is per-caller, not a fixed result", async () => {
    const res = await request(appAs({ distributor_id: DISTRIBUTOR_B, client_id: CLIENT_ID })).get(
      "/distributors/me/segments",
    );

    expect(res.status).toBe(200);
    expect(res.body.segments).toHaveLength(1);
    expect(res.body.segments[0].duration_seconds).toBe(45);
  });
});

describe("GET /distributors/me/rendered-videos - ownership", () => {
  it("only returns the caller's own rendered video when another distributor's exists in the same client", async () => {
    const res = await request(appAs({ distributor_id: DISTRIBUTOR_A, client_id: CLIENT_ID })).get(
      "/distributors/me/rendered-videos",
    );

    expect(res.status).toBe(200);
    expect(res.body.rendered_videos).toHaveLength(1);
    expect(res.body.rendered_videos[0].playback_url).toContain("rendered/a.mp4");
    expect(JSON.stringify(res.body)).not.toContain("rendered/b.mp4");
  });
});

// No route in this codebase accepts a segment ID, video ID, or similar as a
// path or query parameter today (confirmed via a repo-wide search of
// src/routes/ for `req.params`) - every read endpoint is a "me"-scoped list
// (`/distributors/me/segments`, `/distributors/me/rendered-videos`,
// `/distributors/me/questions`), never a single-record lookup by ID. There
// is therefore no literal "request another distributor's segment by ID"
// case to reproduce yet. The tests above cover the equivalent real risk on
// the list endpoints instead: another distributor's row existing in the
// same client must never leak into the caller's response. If a by-ID route
// is ever added (e.g. a future admin dashboard), it must look up the record
// scoped to the caller's own distributor_id and return 404 (not 403) on a
// record that exists but belongs to someone else - a 403 confirms the
// record exists, a 404 doesn't.
