import { randomUUID } from "node:crypto";
import { Router } from "express";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { config } from "../config/env";
import { prisma } from "../db/prisma";

export const registerRouter = Router();

// Hard constraint: self-registered rows only ever land under this one
// client, looked up by name at request time - never accepted from the
// request body. Client.name is @unique, so this is an unambiguous lookup.
// "Zeist" is a dedicated third dummy client (prisma/seed.ts), separate
// from both IFB (which becomes a real client once the actual engagement
// starts) and Voltas, so self-registered test rows can never end up mixed
// into either one, now or in the future.
const INTERNAL_TEST_CLIENT_NAME = "Zeist";

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts, please try again later" },
});

// Mirrors src/routes/dev.ts's gating pattern: when ENABLE_SELF_REGISTRATION
// is off (default), nothing below ever calls `.post` on this router, so it
// never matches - a request falls through to whatever the rest of the app
// does with an unmatched path at that position (src/index.ts mounts this
// right before authMiddleware, so in practice that's authMiddleware's own
// 401, same as any other unauthenticated request to a path nothing
// registered - never a 403 confirming the route exists but is blocked).
// This must default off and stay off once real IFB provisioning exists -
// it's an unauthenticated endpoint that creates real Distributor rows.
if (config.ENABLE_SELF_REGISTRATION) {
  registerRouter.post("/register", registerLimiter, async (req, res) => {
    const { name, phone } = req.body ?? {};

    if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
      res.status(400).json({ error: "name is required and must be a non-empty string up to 200 characters" });
      return;
    }
    if (phone !== undefined && phone !== null && (typeof phone !== "string" || phone.length > 50)) {
      res.status(400).json({ error: "phone must be a string up to 50 characters, if provided" });
      return;
    }

    const client = await prisma.client.findUnique({ where: { name: INTERNAL_TEST_CLIENT_NAME } });
    if (!client) {
      console.error(
        `[register] internal-test client "${INTERNAL_TEST_CLIENT_NAME}" not found - has the seed script been run?`,
      );
      res.status(500).json({ error: "internal_test_client_not_configured" });
      return;
    }

    // invite_token is required + unique on Distributor even though this
    // path has no real invite - a random one just satisfies the column,
    // never handed back or used to look this row up again (session comes
    // from the JWT below, same as every other distributor).
    const distributor = await prisma.distributor.create({
      data: {
        client_id: client.id,
        name: name.trim(),
        phone: typeof phone === "string" ? phone.trim() : null,
        invite_token: `self-registered-${randomUUID()}`,
        language_pref: "en",
      },
    });

    const token = jwt.sign(
      { distributor_id: distributor.id, client_id: distributor.client_id },
      config.SESSION_SECRET,
      { algorithm: "HS256", expiresIn: "30d" },
    );

    res.status(201).json({ token });
  });
}
