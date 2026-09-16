import { randomUUID } from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { config } from "../config/env";
import { prisma } from "../db/prisma";
import { normalizePhone } from "../services/phone";

export const registerRouter = Router();

// Hard constraint: self-registered rows only ever land under this one
// client, looked up by name at request time - never accepted from the
// request body. Client.name is @unique, so this is an unambiguous lookup.
// "Zeist" is a dedicated third dummy client (prisma/seed.ts), separate
// from both IFB (which becomes a real client once the actual engagement
// starts) and Voltas, so self-registered test rows can never end up mixed
// into either one, now or in the future.
const INTERNAL_TEST_CLIENT_NAME = "Zeist";

const MIN_PASSWORD_LENGTH = 6;

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many registration attempts, please try again later" },
});

// Mirrors src/routes/dashboard.ts's gating pattern: when ENABLE_SELF_REGISTRATION
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
    const { name, phone, password } = req.body ?? {};

    if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
      res.status(400).json({ error: "name is required and must be a non-empty string up to 200 characters" });
      return;
    }
    if (typeof phone !== "string" || normalizePhone(phone).length !== 10) {
      res.status(400).json({ error: "phone is required and must contain a valid 10-digit mobile number" });
      return;
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `password is required and must be at least ${MIN_PASSWORD_LENGTH} characters` });
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

    const normalizedPhone = normalizePhone(phone);
    const passwordHash = bcrypt.hashSync(password, 10);

    try {
      // invite_token is required + unique on Distributor even though this
      // path has no real invite - a random one just satisfies the column,
      // never handed back or used to look this row up again (session comes
      // from the JWT below, same as every other distributor).
      const distributor = await prisma.distributor.create({
        data: {
          client_id: client.id,
          name: name.trim(),
          phone: normalizedPhone,
          password_hash: passwordHash,
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
    } catch (err) {
      // phone is @unique - a collision here means someone's re-registering
      // a number that already has an account, not a real error. Point them
      // at /login/phone instead of silently creating a duplicate or
      // clobbering the existing row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        res.status(409).json({
          error: "phone_already_registered",
          message: "This phone number is already registered. Please log in instead.",
        });
        return;
      }
      throw err;
    }
  });
}
