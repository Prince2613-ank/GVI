import { NextFunction, Request, Response } from "express";

/**
 * This service has no login/session system of its own — mutating routes
 * (start/pause/resume/cancel/retry/regenerate) are gated behind a single
 * shared-secret bearer token (ADMIN_TOKEN) instead of real user accounts.
 * Good enough for one admin operating this pipeline; swap for real auth if
 * this ever needs multiple operators or an audit trail of who triggered what.
 */
export function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env.ADMIN_TOKEN;
  if (!configured) {
    res.status(500).json({ error: "ADMIN_TOKEN is not configured on the server" });
    return;
  }
  const header = req.headers.authorization;
  const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  if (provided !== configured) {
    res.status(401).json({ error: "Invalid or missing admin token" });
    return;
  }
  next();
}
