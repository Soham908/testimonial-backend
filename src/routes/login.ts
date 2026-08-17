import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import { config } from "../config/env";
import { prisma } from "../db/prisma";
import { SEED_ACCOUNTS } from "../config/seedAccounts";

export const loginRouter = Router();

// Unknown-username requests previously skipped bcrypt entirely, making them
// measurably faster than wrong-password requests — a timing side channel an
// attacker could use to enumerate valid usernames. Comparing against a fixed
// dummy hash on that path costs the same ~bcrypt-round time either way.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing-normalization", 10);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
});

loginRouter.post("/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body ?? {};

  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password are required" });
    return;
  }

  const account = SEED_ACCOUNTS.find((a) => a.username === username);
  const validPassword = bcrypt.compareSync(password, account?.passwordHash ?? DUMMY_HASH);

  if (!account || !validPassword) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const distributor = await prisma.distributor.findUnique({
    where: { invite_token: account.invite_token },
    select: { id: true, client_id: true },
  });

  if (!distributor) {
    res.status(500).json({ error: "Seeded account has no matching distributor row" });
    return;
  }

  const token = jwt.sign(
    { distributor_id: distributor.id, client_id: distributor.client_id },
    config.SESSION_SECRET,
    { algorithm: "HS256", expiresIn: "30d" },
  );

  res.json({ token });
});
