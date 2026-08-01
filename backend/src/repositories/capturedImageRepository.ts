import { pool } from "../db/client";
import { GvCapturedImage } from "../types";

export const capturedImageRepository = {
  async create(input: {
    viewpointId: string;
    imagePath: string;
    width: number;
    height: number;
    contentType: string;
    byteSize: number | null;
  }): Promise<GvCapturedImage> {
    const { rows } = await pool.query<GvCapturedImage>(
      `INSERT INTO gv_captured_images (viewpoint_id, image_path, width, height, content_type, byte_size)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [input.viewpointId, input.imagePath, input.width, input.height, input.contentType, input.byteSize]
    );
    return rows[0];
  },
};
