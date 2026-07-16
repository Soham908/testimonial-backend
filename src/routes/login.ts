import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config/env";
import { prisma } from "../db/prisma";
import { SEED_ACCOUNTS } from "../config/seedAccounts";

export const loginRouter = Router();

loginRouter.post("/login", async (req, res) => {
  const { username, password } = req.body ?? {};

  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password are required" });
    return;
  }

  const account = SEED_ACCOUNTS.find((a) => a.username === username);
  const validPassword = account ? bcrypt.compareSync(password, account.passwordHash) : false;

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
    { expiresIn: "30d" },
  );

  res.json({ token });
});
