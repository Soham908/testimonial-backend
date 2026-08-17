import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "./config/env";
import { loginRouter } from "./routes/login";
import { meRouter } from "./routes/me";
import { segmentsRouter } from "./routes/segments";
import { distributorsRouter } from "./routes/distributors";
import { authMiddleware } from "./middleware/auth";

const app = express();

// Eventual host is AWS App Runner (see CLAUDE.md), which terminates TLS and
// proxies in front of the app — trusting the first hop makes req.ip and the
// rate limiter below key on the real client IP instead of the proxy's.
app.set("trust proxy", 1);

app.use(helmet());

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`[http] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(loginRouter);

app.use(authMiddleware);
app.use(meRouter);
app.use(segmentsRouter);
app.use(distributorsRouter);

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

// Catches anything a route handler threw or rejected with (Express 5 forwards
// async rejections here automatically). Without this, Express's own default
// handler responds instead — which includes the error's stack trace in the
// body unless NODE_ENV is exactly "production", an easy thing to forget to
// set on a real deployment.
app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[http] ${req.method} ${req.path} unhandled error:`, err);
  // express.json() throws with .type === "entity.parse.failed" on malformed
  // JSON bodies — that's a client mistake, not a server failure, so it gets
  // its own 400 rather than falling into the generic 500 below.
  if ((err as { type?: string })?.type === "entity.parse.failed") {
    res.status(400).json({ error: "invalid_json" });
    return;
  }
  res.status(500).json({ error: "internal_server_error" });
});

app.listen(config.PORT, () => {
  console.log(`testimonial-backend listening on port ${config.PORT}`);
});
