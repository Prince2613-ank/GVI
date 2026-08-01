import { pool } from "../db/client";
import { GvFloor } from "../types";

export const floorRepository = {
  async findById(id: string): Promise<GvFloor | null> {
    const { rows } = await pool.query<GvFloor>(`SELECT * FROM gv_floors WHERE id = $1`, [id]);
    return rows[0] ?? null;
  },

  async listByBuilding(buildingId: string): Promise<GvFloor[]> {
    const { rows } = await pool.query<GvFloor>(
      `SELECT * FROM gv_floors WHERE building_id = $1 ORDER BY floor_number ASC`,
      [buildingId]
    );
    return rows;
  },

  async findByNumber(buildingId: string, floorNumber: number): Promise<GvFloor | null> {
    const { rows } = await pool.query<GvFloor>(
      `SELECT * FROM gv_floors WHERE building_id = $1 AND floor_number = $2 LIMIT 1`,
      [buildingId, floorNumber]
    );
    return rows[0] ?? null;
  },
};
