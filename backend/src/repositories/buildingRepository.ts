import { pool } from "../db/client";
import { GvBuilding } from "../types";

export const buildingRepository = {
  async findById(id: string): Promise<GvBuilding | null> {
    const { rows } = await pool.query<GvBuilding>(`SELECT * FROM gv_buildings WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async list(): Promise<GvBuilding[]> {
    const { rows } = await pool.query<GvBuilding>(`SELECT * FROM gv_buildings ORDER BY created_at ASC`);
    return rows;
  },
};
