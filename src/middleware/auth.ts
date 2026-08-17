import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/env";

type SessionPayload = {
  distributor_id: string;
  client_id: string;
};

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ error: "Missing session token" });
    return;
  }

  try {
    const payload = jwt.verify(token, config.SESSION_SECRET, { algorithms: ["HS256"] }) as SessionPayload;
    req.auth = { distributor_id: payload.distributor_id, client_id: payload.client_id };
    next();
  } catch {
    res.status(401).json({ error: "Invalid session token" });
  }
}
