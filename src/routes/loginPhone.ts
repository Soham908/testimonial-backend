import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { config } from "../config/env";
import { prisma } from "../db/prisma";
import { normalizePhone } from "../services/phone";

export const loginPhoneRouter = Router();

// Same timing-normalization reasoning as login.ts's DUMMY_HASH: an
// unknown-phone request must cost the same ~bcrypt-round time as a
// wrong-password one, or the difference becomes a side channel for
// enumerating registered phone numbers.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing-normalization", 10);

const loginPhoneLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
});

// Login counterpart to POST /register - only self-registered distributors
// have a phone+password to log in with (password_hash is null for every
// seeded/invite-token account), so this is gated behind the same
// ENABLE_SELF_REGISTRATION flag and gets the same "never registered at all"
// treatment when it's off. See src/routes/register.ts for the full gating
// rationale.
if (config.ENABLE_SELF_REGISTRATION) {
  loginPhoneRouter.post("/login/phone", loginPhoneLimiter, async (req, res) => {
    const { phone, password } = req.body ?? {};

    if (typeof phone !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "phone and password are required" });
      return;
    }

    const distributor = await prisma.distributor.findUnique({
      where: { phone: normalizePhone(phone) },
      select: { id: true, client_id: true, password_hash: true },
    });

    const validPassword = bcrypt.compareSync(password, distributor?.password_hash ?? DUMMY_HASH);

    // Same generic message either way (unknown phone vs. wrong password) -
    // distinguishing them would let a caller enumerate registered numbers.
    if (!distributor || !distributor.password_hash || !validPassword) {
      res.status(401).json({ error: "Invalid phone or password" });
      return;
    }

    const token = jwt.sign(
      { distributor_id: distributor.id, client_id: distributor.client_id },
      config.SESSION_SECRET,
      { algorithm: "HS256", expiresIn: "30d" },
    );

    res.json({ token });
  });
}
