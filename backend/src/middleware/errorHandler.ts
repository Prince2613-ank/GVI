import { NextFunction, Request, Response } from "express";
import { NotFoundError, ValidationError } from "../errors";

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  console.error("[error]", err);
  res.status(500).json({ error: "Internal server error" });
}
