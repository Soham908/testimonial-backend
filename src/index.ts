import express from "express";
import { config } from "./config/env";
import { loginRouter } from "./routes/login";
import { meRouter } from "./routes/me";
import { segmentsRouter } from "./routes/segments";
import { distributorsRouter } from "./routes/distributors";
import { authMiddleware } from "./middleware/auth";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use(loginRouter);

app.use(authMiddleware);
app.use(meRouter);
app.use(segmentsRouter);
app.use(distributorsRouter);

app.listen(config.PORT, () => {
  console.log(`testimonial-backend listening on port ${config.PORT}`);
});
