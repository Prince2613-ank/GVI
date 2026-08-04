import "dotenv/config";
import express from "express";
import cors from "cors";
import balconyViewpointsRouter from "./routes/balconyViewpoints";
import mediaRouter from "./routes/media";
import vegetationHeightsRouter from "./routes/vegetationHeights";
import { pool } from "./db/client";
import { errorHandler } from "./middleware/errorHandler";
import { resumeUnfinishedOnBoot } from "./services/balconyGeneration/generationQueue";

const app = express();
const PORT = parseInt(process.env.PORT ?? "4100");

app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*" }));
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
