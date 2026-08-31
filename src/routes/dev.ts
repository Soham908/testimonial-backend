import { Router } from "express";
import { prisma } from "../db/prisma";
import { config } from "../config/env";

// Home for internal/debug routes - never part of the mobile app's
// documented API surface (API_CONTRACT.md explicitly excludes them). Every
// route here is gated behind ENABLE_DEV_ENDPOINTS (default off): when the
// flag is off, nothing below ever calls `.get`/`.post` on this router, so
// the route plain doesn't exist - a request to it 404s the same as any
// other unknown path, rather than a 403 that would confirm the route is
// there but blocked. src/index.ts mounts this router unconditionally; the
// gate lives here, in one place, so any future dev-only route just needs
// to live in this file to get the same protection.
export const devRouter = Router();

if (config.ENABLE_DEV_ENDPOINTS) {
  // Temporary test-only endpoint for inspecting sentiment analysis output.
  // Scoped by client_id (not distributor_id) deliberately, not narrowed to
  // the requesting distributor - this is internal/company data (moderation
  // flags and complaint flags are judgements about the person being
  // reviewed), and no distributor should see them about themselves either.
  // Not part of the documented API surface in backend-plan.html; the real
  // version is that doc's GET /clients/:id/insights (Phase 7, needs actual
  // admin auth that doesn't exist yet in Phase A - this is a stand-in for
  // that until then, not a permanent shape).
  devRouter.get("/segments/sentiment", async (req, res) => {
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
            extracted: true,
            created_at: true,
          },
        },
      },
    });

    res.json({ results: segments });
  });
}
