import { pool } from "../db/client";
import { BalconyDirection, GvViewpoint } from "../types";

export const viewpointRepository = {
  async findById(id: string): Promise<GvViewpoint | null> {
    const { rows } = await pool.query<GvViewpoint>(`SELECT * FROM gv_viewpoints WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async listByBuilding(buildingId: string): Promise<GvViewpoint[]> {
    const { rows } = await pool.query<GvViewpoint>(
      `SELECT * FROM gv_viewpoints WHERE building_id = $1 ORDER BY floor_id, direction, flat_number`,
      [buildingId]
    );
    return rows;
  },

  async listByBuildingAndFloor(buildingId: string, floorId: string): Promise<GvViewpoint[]> {
    const { rows } = await pool.query<GvViewpoint>(
      `SELECT * FROM gv_viewpoints WHERE building_id = $1 AND floor_id = $2 ORDER BY direction, flat_number`,
      [buildingId, floorId]
    );
    return rows;
  },

  /**
   * Upsert-by-slot: creates the viewpoint on first discovery with placeholder
   * (0,0,0) geometry that the capture worker fills in for real once it flies
   * there. Re-running discovery must never clobber a viewpoint that's
   * already been captured, so on conflict nothing about its stored geometry/
   * status/gvi is touched.
   */
  async upsertSlot(input: {
    buildingId: string;
    floorId: string;
    direction: BalconyDirection;
    flatNumber: number;
  }): Promise<GvViewpoint> {
    const { rows } = await pool.query<GvViewpoint>(
      `INSERT INTO gv_viewpoints (building_id, floor_id, direction, flat_number, longitude, latitude, height, status)
       VALUES ($1,$2,$3,$4,0,0,0,'pending')
       ON CONFLICT (building_id, floor_id, direction, flat_number)
       DO UPDATE SET building_id = gv_viewpoints.building_id
       RETURNING *`,
      [input.buildingId, input.floorId, input.direction, input.flatNumber]
    );
    return rows[0];
  },

  async setStatus(id: string, status: string): Promise<void> {
    await pool.query(`UPDATE gv_viewpoints SET status = $2 WHERE id = $1`, [id, status]);
  },

  /** Looks a viewpoint up by (building, floor NUMBER, direction, flat) — used when syncing manually-captured positions in from the browser-local debug tool, which only knows floor numbers, not floor UUIDs. */
  async findBySlotFloorNumber(
    buildingId: string,
    floorNumber: number,
    direction: BalconyDirection,
    flatNumber: number
  ): Promise<GvViewpoint | null> {
    const { rows } = await pool.query<GvViewpoint>(
      `SELECT v.* FROM gv_viewpoints v
       JOIN gv_floors f ON f.id = v.floor_id
       WHERE v.building_id = $1 AND f.floor_number = $2 AND v.direction = $3 AND v.flat_number = $4
       LIMIT 1`,
      [buildingId, floorNumber, direction, flatNumber]
    );
    return rows[0] ?? null;
  },

  /**
   * Overwrites a viewpoint's camera position with a manually-verified one
   * (e.g. synced from the Live Balcony Position Debug tool) — this is the
   * ONLY thing that changes; any existing preview/GVI stays in place until
   * the viewpoint is regenerated against the new position.
   */
  async updatePosition(
    id: string,
    position: { longitude: number; latitude: number; height: number }
  ): Promise<void> {
    await pool.query(
      `UPDATE gv_viewpoints SET longitude = $2, latitude = $3, height = $4 WHERE id = $1`,
      [id, position.longitude, position.latitude, position.height]
    );
  },

  /**
   * Wipes a viewpoint's preview/GVI data back to its never-captured state
   * (position stays put — this is a data reset, not a slot deletion, since
   * the slot itself is a fixed building/floor/direction/flat combination
   * that must keep existing for future re-capture). Used to permanently
   * remove entries from the GVI leaderboard/ranking.
   */
  async clearCaptureResult(id: string): Promise<void> {
    await pool.query(
      `UPDATE gv_viewpoints SET
         preview_image_path = NULL,
         preview_captured_at = NULL,
         gvi = NULL,
         green_pixels = NULL,
         grey_pixels = NULL,
         analysis_date = NULL,
         status = 'pending'
       WHERE id = $1`,
      [id]
    );
  },

  async saveCaptureResult(
    id: string,
    fields: {
      previewImagePath: string;
      previewCapturedAt: string;
      gvi: number;
      greenPixels: number;
      greyPixels: number;
      analysisDate: string;
      status: string;
      camera?: { longitude: number; latitude: number; height: number; heading: number; pitch: number; roll: number };
    }
  ): Promise<void> {
    await pool.query(
      `UPDATE gv_viewpoints SET
         preview_image_path = $2,
         preview_captured_at = $3,
         gvi = $4,
         green_pixels = $5,
         grey_pixels = $6,
         analysis_date = $7,
         status = $8,
         longitude = COALESCE($9, longitude),
         latitude = COALESCE($10, latitude),
         height = COALESCE($11, height),
         heading = COALESCE($12, heading),
         pitch = COALESCE($13, pitch),
         roll = COALESCE($14, roll)
       WHERE id = $1`,
      [
        id,
        fields.previewImagePath,
        fields.previewCapturedAt,
        fields.gvi,
        fields.greenPixels,
        fields.greyPixels,
        fields.analysisDate,
        fields.status,
        fields.camera?.longitude ?? null,
        fields.camera?.latitude ?? null,
        fields.camera?.height ?? null,
        fields.camera?.heading ?? null,
        fields.camera?.pitch ?? null,
        fields.camera?.roll ?? null,
      ]
    );
  },
};
