import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { pool } from "../db/client";
import { getWellnessSnapshot } from "../services/wellness/wellnessAggregatorService";

const router = Router();

router.get(
  "/:buildingId",
  asyncHandler(async (req, res) => {
    const { buildingId } = req.params;
    const forceRefresh = req.query.refresh === "true";

    const { rows } = await pool.query<{ latitude: number; longitude: number }>(
      `SELECT latitude, longitude FROM gv_buildings WHERE id = $1`,
      [buildingId]
    );
    const building = rows[0];
    if (!building) {
      res.status(404).json({ error: "Building not found" });
      return;
    }

    const snapshot = await getWellnessSnapshot(
      buildingId,
      building.latitude,
      building.longitude,
      forceRefresh
    );
    res.json(snapshot);
  })
);

export default router;
