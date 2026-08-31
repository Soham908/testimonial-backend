import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../src/db/prisma", () => ({
  prisma: {
    segment: {
      findMany: vi.fn(async () => [
        {
          id: "seg-a",
          question_index: 1,
          distributor: { name: "Distributor A" },
          sentiment_result: { sentiment_score: 0.8 },
        },
      ]),
    },
  },
}));

const ORIGINAL_FLAG = process.env.ENABLE_DEV_ENDPOINTS;

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_DEV_ENDPOINTS;
  else process.env.ENABLE_DEV_ENDPOINTS = ORIGINAL_FLAG;
});

// src/routes/dev.ts decides whether to register a route on `devRouter` at
// module-import time, based on config.ENABLE_DEV_ENDPOINTS - so exercising
// both states means resetting the module registry and re-importing fresh
// with a different process.env value each time, not just re-checking a
// runtime flag inside a single loaded instance.
async function loadDevRouter(enabled: boolean) {
  vi.resetModules();
  process.env.ENABLE_DEV_ENDPOINTS = enabled ? "true" : "false";
  const { devRouter } = await import("../src/routes/dev");
  return devRouter;
}

function appWith(router: express.Router, auth = { distributor_id: "d1", client_id: "c1" }) {
  const app = express();
  app.use((req, _res, next) => {
    req.auth = auth;
    next();
  });
  app.use(router);
  // Mirrors src/index.ts's own catch-all, so a request that matches nothing
  // gets the same generic shape the real app would give it - not an
  // Express-default HTML 404 page that only happens to also be a 404.
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });
  return app;
}

describe("dev-only routes (ENABLE_DEV_ENDPOINTS)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /segments/sentiment is unreachable when the flag is off (default) - a plain 404, not 403", async () => {
    const devRouter = await loadDevRouter(false);
    const res = await request(appWith(devRouter)).get("/segments/sentiment");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("is also unreachable with no ENABLE_DEV_ENDPOINTS set at all, not just an explicit 'false'", async () => {
    vi.resetModules();
    delete process.env.ENABLE_DEV_ENDPOINTS;
    const { devRouter } = await import("../src/routes/dev");

    const res = await request(appWith(devRouter)).get("/segments/sentiment");
    expect(res.status).toBe(404);
  });

  it("GET /segments/sentiment works (and stays client-wide, not narrowed to the caller) when the flag is explicitly on", async () => {
    const devRouter = await loadDevRouter(true);
    const res = await request(appWith(devRouter)).get("/segments/sentiment");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].distributor.name).toBe("Distributor A");
  });
});
