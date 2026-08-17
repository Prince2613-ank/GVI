import "dotenv/config";
import express from "express";
import cors from "cors";
import balconyViewpointsRouter from "./routes/balconyViewpoints";
import mediaRouter from "./routes/media";
import vegetationHeightsRouter from "./routes/vegetationHeights";
import wellnessRouter from "./routes/wellness";
import vegetationHealthRouter from "./routes/vegetationHealth";
import { pool } from "./db/client";
import { errorHandler } from "./middleware/errorHandler";
import { resumeUnfinishedOnBoot } from "./services/balconyGeneration/generationQueue";

const app = express();
const PORT = parseInt(process.env.PORT ?? "4100");

// CORS_ORIGIN holds the fixed production origin(s) (comma-separated). Vercel
// preview deployments get a fresh *.vercel.app origin per branch/deploy that
// can never be listed in advance, so those are allowed independently of the
// env var — otherwise every preview build's API calls are blocked by the
// browser before they ever reach this server.
const configuredOrigins = (process.env.CORS_ORIGIN ?? "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowAllOrigins = configuredOrigins.includes("*");
const isVercelPreviewOrigin = (origin: string) => /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowAllOrigins || configuredOrigins.includes(origin) || isVercelPreviewOrigin(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
  })
);
// Manual captures/regenerations carry base64 image data URLs (a 1280x720
// JPEG preview + an optional mask image) — both comfortably clear Express's
// 100kb JSON default, so this needs raising explicitly.
app.use(express.json({ limit: "20mb" }));

app.get("/", (_req, res) => {
  res.json({ service: "green-view-backend", health: "/api/health" });
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected" });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

app.use("/api/balcony-viewpoints", balconyViewpointsRouter);
app.use("/api/media", mediaRouter);
app.use("/api/vegetation-heights", vegetationHeightsRouter);
app.use("/api/wellness", wellnessRouter);
app.use("/api/vegetation-health", vegetationHealthRouter);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`[green-view-backend] running on http://localhost:${PORT}`);
  console.log(`[green-view-backend] health → http://localhost:${PORT}/api/health`);

  // "If application closes, resume from last completed job" — any job still
  // queued/in-flight from before this restart continues automatically.
  resumeUnfinishedOnBoot().catch((error) => {
    console.error("[balcony-generation] failed to resume unfinished jobs on boot:", error);
  });
});
