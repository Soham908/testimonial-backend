import express from "express";
import { config } from "./config/env";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(config.PORT, () => {
  console.log(`testimonial-backend listening on port ${config.PORT}`);
});
