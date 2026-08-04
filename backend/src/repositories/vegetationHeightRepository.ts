import { pool } from "../db/client";
import { GvManualVegetationHeight } from "../types";

export const vegetationHeightRepository = {
  /** Batch lookup — one round trip for every polygon a client is about to render, not one query per polygon. */
  async findMany(
    keys: { polygonId: string; clientUpdatedAt: number }[]
  ): Promise<GvManualVegetationHeight[]> {
    if (keys.length === 0) return [];
    const polygonIds = keys.map((k) => k.polygonId);
    const updatedAts = keys.map((k) => k.clientUpdatedAt);
    const { rows } = await pool.query<GvManualVegetationHeight>(
      `SELECT * FROM gv_manual_vegetation_heights
       WHERE (polygon_id, client_updated_at) IN (
         SELECT * FROM UNNEST($1::text[], $2::bigint[])
       )`,
      [polygonIds, updatedAts]
    );
    return rows;
  },

  /** Batch upsert — a full "Analyse GVI" pass can resolve dozens of polygons' heights at once; save them all in one query. */
  async upsertMany(
    entries: { polygonId: string; clientUpdatedAt: number; heightM: number }[]
  ): Promise<void> {
    if (entries.length === 0) return;
    const polygonIds = entries.map((e) => e.polygonId);
    const updatedAts = entries.map((e) => e.clientUpdatedAt);
    const heights = entries.map((e) => e.heightM);
    await pool.query(
      `INSERT INTO gv_manual_vegetation_heights (polygon_id, client_updated_at, height_m)
       SELECT * FROM UNNEST($1::text[], $2::bigint[], $3::double precision[])
       ON CONFLICT (polygon_id, client_updated_at)
       DO UPDATE SET height_m = EXCLUDED.height_m, resolved_at = now()`,
      [polygonIds, updatedAts, heights]
    );
  },
};
