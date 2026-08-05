import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler";
import { pool } from "../db/client";
import { computeVegetationHealth } from "../services/vegetationHealth/vegetationHealthService";

const router = Router();

router.get(
  "/:buildingId",
  asyncHandler(async (req, res) => {
    const { buildingId } = req.params;

    const { rows } = await pool.query<{ latitude: number; longitude: number }>(
      `SELECT latitude, longitude FROM gv_buildings WHERE id = $1`,
      [buildingId]
    );
    const building = rows[0];
    if (!building) {
      res.status(404).json({ error: "Building not found" });
      return;
    }

    const result = await computeVegetationHealth(building.latitude, building.longitude);
    res.json(result);
  })
);

export default router;
