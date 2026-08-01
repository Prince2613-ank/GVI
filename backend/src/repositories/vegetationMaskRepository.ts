import { pool } from "../db/client";
import { GvVegetationMask } from "../types";

export const vegetationMaskRepository = {
  async create(input: { gviResultId: string; maskImagePath: string; pixelCount: number }): Promise<GvVegetationMask> {
    const { rows } = await pool.query<GvVegetationMask>(
      `INSERT INTO gv_vegetation_masks (gvi_result_id, mask_image_path, pixel_count)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.gviResultId, input.maskImagePath, input.pixelCount]
    );
    return rows[0];
  },
};
