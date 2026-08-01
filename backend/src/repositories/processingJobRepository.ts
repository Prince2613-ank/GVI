import { pool } from "../db/client";
import { GvProcessingJob, ProcessingJobStatus } from "../types";

export const processingJobRepository = {
  async create(viewpointId: string, maxAttempts = 3): Promise<GvProcessingJob> {
    const { rows } = await pool.query<GvProcessingJob>(
      `INSERT INTO gv_processing_jobs (viewpoint_id, status, max_attempts)
       VALUES ($1, 'queued', $2)
       RETURNING *`,
      [viewpointId, maxAttempts]
    );
    return rows[0];
  },

  async findNextPending(): Promise<GvProcessingJob | null> {
    const { rows } = await pool.query<GvProcessingJob>(
      `SELECT * FROM gv_processing_jobs WHERE status IN ('pending','queued') ORDER BY created_at ASC LIMIT 1`
    );
    return rows[0] ?? null;
  },

  async listUnfinished(): Promise<GvProcessingJob[]> {
    const { rows } = await pool.query<GvProcessingJob>(
      `SELECT * FROM gv_processing_jobs WHERE status NOT IN ('completed','failed') ORDER BY created_at ASC`
    );
    return rows;
  },

  async listByStatus(status: ProcessingJobStatus): Promise<GvProcessingJob[]> {
    const { rows } = await pool.query<GvProcessingJob>(
      `SELECT * FROM gv_processing_jobs WHERE status = $1 ORDER BY created_at ASC`,
      [status]
    );
    return rows;
  },

  async countByStatus(): Promise<Record<string, number>> {
    const { rows } = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM gv_processing_jobs GROUP BY status`
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  },

  async setStatus(id: string, status: ProcessingJobStatus, errorMessage?: string | null): Promise<GvProcessingJob | null> {
    const startedAtClause = status === "rendering" ? `started_at = COALESCE(started_at, now()),` : "";
    const completedAtClause = status === "completed" || status === "failed" ? `completed_at = now(),` : "";
    const { rows } = await pool.query<GvProcessingJob>(
      `UPDATE gv_processing_jobs
       SET status = $2, ${startedAtClause} ${completedAtClause} error_message = $3
       WHERE id = $1
       RETURNING *`,
      [id, status, errorMessage ?? null]
    );
    return rows[0] ?? null;
  },

  async incrementAttempt(id: string): Promise<GvProcessingJob | null> {
    const { rows } = await pool.query<GvProcessingJob>(
      `UPDATE gv_processing_jobs SET attempt = attempt + 1 WHERE id = $1 RETURNING *`,
      [id]
    );
    return rows[0] ?? null;
  },

  async requeue(id: string): Promise<GvProcessingJob | null> {
    const { rows } = await pool.query<GvProcessingJob>(
      `UPDATE gv_processing_jobs
       SET status = 'queued', error_message = null, started_at = null, completed_at = null
       WHERE id = $1
       RETURNING *`,
      [id]
    );
    return rows[0] ?? null;
  },

  async findLatestByViewpoint(viewpointId: string): Promise<GvProcessingJob | null> {
    const { rows } = await pool.query<GvProcessingJob>(
      `SELECT * FROM gv_processing_jobs WHERE viewpoint_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [viewpointId]
    );
    return rows[0] ?? null;
  },

  /** Drops any not-yet-started job for a viewpoint that's about to be completed manually — there's nothing left for the automated worker to do there. */
  async deletePendingForViewpoint(viewpointId: string): Promise<number> {
    const { rowCount } = await pool.query(
      `DELETE FROM gv_processing_jobs WHERE viewpoint_id = $1 AND status IN ('pending','queued')`,
      [viewpointId]
    );
    return rowCount ?? 0;
  },

  async resetInFlightToQueued(): Promise<number> {
    const { rowCount } = await pool.query(
      `UPDATE gv_processing_jobs SET status = 'queued' WHERE status IN ('rendering','capturing','analyzing','saving')`
    );
    return rowCount ?? 0;
  },
};
