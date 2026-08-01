import { pool } from "../db/client";
import { GvGviResult } from "../types";

export const gviResultRepository = {
  async create(input: {
    viewpointId: string;
    capturedImageId: string | null;
    gviScore: number;
    greenPixels: number;
    greyPixels: number;
    totalPixels: number;
    processingTimeMs: number | null;
  }): Promise<GvGviResult> {
    const { rows } = await pool.query<GvGviResult>(
      `INSERT INTO gv_gvi_results (
         viewpoint_id, captured_image_id, gvi_score, green_pixels, grey_pixels,
         total_pixels, processing_time_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        input.viewpointId,
        input.capturedImageId,
        input.gviScore,
        input.greenPixels,
        input.greyPixels,
        input.totalPixels,
        input.processingTimeMs,
      ]
    );
    return rows[0];
  },
};
