import { Router } from "express";

export const meRouter = Router();

meRouter.get("/me", (req, res) => {
  res.json({ auth: req.auth });
});
