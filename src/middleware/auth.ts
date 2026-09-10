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
    res.status(401).json({ error: "missing_token", message: "Missing session token" });
    return;
  }

  try {
    const payload = jwt.verify(token, config.SESSION_SECRET, { algorithms: ["HS256"] }) as SessionPayload;
    req.auth = { distributor_id: payload.distributor_id, client_id: payload.client_id };
    next();
  } catch (err) {
    // Distinguished from a generic invalid token so the frontend can react
    // differently (silently re-login vs. surface an error) - the one case
    // where the token was once valid and just needs replacing, not evidence
    // of a malformed/forged request. There's no revocation mechanism yet
    // (stateless JWTs, no session store) - "revoked" would land here too
    // once one exists, but today only real expiry hits this branch.
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: "token_expired", message: "Session expired, please log in again" });
      return;
    }
    res.status(401).json({ error: "invalid_token", message: "Invalid session token" });
  }
}
