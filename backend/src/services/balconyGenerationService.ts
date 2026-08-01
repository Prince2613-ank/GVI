import { pool } from "../db/client";
import { viewpointRepository } from "../repositories/viewpointRepository";
import { processingJobRepository } from "../repositories/processingJobRepository";
import { floorRepository } from "../repositories/floorRepository";
import { capturedImageRepository } from "../repositories/capturedImageRepository";
import { gviResultRepository } from "../repositories/gviResultRepository";
import { vegetationMaskRepository } from "../repositories/vegetationMaskRepository";
import { imageStorage } from "./storage";
import {
  startGeneration,
  pauseGeneration,
  resumeGeneration,
  cancelGeneration,
  retryFailedJobs,
  regenerateViewpoint,
  regenerateFloor,
  getQueueRuntimeState,
} from "./balconyGeneration/generationQueue";
import { BalconyDirection, GvViewpoint } from "../types";
import { NotFoundError, ValidationError } from "../errors";
import { DEMO_BUILDING_ID } from "../config";

const MEDIA_ROUTE_PREFIX = "/api/media";

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; contentType: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new ValidationError("previewImageDataUrl must be a data: URL");
  return { buffer: Buffer.from(match[2], "base64"), contentType: match[1] };
}

function toPublicViewpoint(viewpoint: GvViewpoint, floorNumber: number | null = null) {
  return {
    id: viewpoint.id,
    buildingId: viewpoint.building_id,
    floorId: viewpoint.floor_id,
    floorNumber,
    room: viewpoint.room,
    direction: viewpoint.direction,
    flatNumber: viewpoint.flat_number,
    camera: {
      longitude: viewpoint.longitude,
      latitude: viewpoint.latitude,
      height: viewpoint.height,
      heading: viewpoint.heading,
      pitch: viewpoint.pitch,
      roll: viewpoint.roll,
    },
    previewImageUrl: viewpoint.preview_image_path ? `${MEDIA_ROUTE_PREFIX}/${viewpoint.preview_image_path}` : null,
    previewCapturedAt: viewpoint.preview_captured_at,
    gvi: viewpoint.gvi !== null ? Number(viewpoint.gvi) : null,
    greenPixels: viewpoint.green_pixels !== null ? Number(viewpoint.green_pixels) : null,
    greyPixels: viewpoint.grey_pixels !== null ? Number(viewpoint.grey_pixels) : null,
    analysisDate: viewpoint.analysis_date,
    status: viewpoint.status,
  };
}

export const balconyGenerationService = {
  async listViewpoints(buildingId: string, floorId?: string) {
    const viewpoints = floorId
      ? await viewpointRepository.listByBuildingAndFloor(buildingId, floorId)
      : await viewpointRepository.listByBuilding(buildingId);
    const floors = await floorRepository.listByBuilding(buildingId);
    const floorNumberById = new Map(floors.map((f) => [f.id, f.floor_number]));
    return viewpoints.map((v) => toPublicViewpoint(v, floorNumberById.get(v.floor_id) ?? null));
  },

  async getViewpoint(id: string) {
    const viewpoint = await viewpointRepository.findById(id);
    if (!viewpoint) throw new NotFoundError("Viewpoint", id);
    const floor = await floorRepository.findById(viewpoint.floor_id);
    const job = await processingJobRepository.findLatestByViewpoint(id);
    return {
      ...toPublicViewpoint(viewpoint, floor?.floor_number ?? null),
      latestJob: job ? { id: job.id, status: job.status, attempt: job.attempt, errorMessage: job.error_message } : null,
    };
  },

  startGeneration,
  pause: pauseGeneration,
  resume: resumeGeneration,
  cancel: cancelGeneration,
  retryFailed: retryFailedJobs,

  async regenerateOne(viewpointId: string) {
    const viewpoint = await viewpointRepository.findById(viewpointId);
    if (!viewpoint) throw new NotFoundError("Viewpoint", viewpointId);
    return regenerateViewpoint(viewpointId);
  },

  /**
   * Stores a manually-captured viewpoint DIRECTLY as completed — no
   * automation job, no Puppeteer round-trip. The exact screenshot the user
   * just captured live in their own browser (via "Save Point" in the Live
   * Balcony Position Debug tool) becomes this viewpoint's permanent preview,
   * reused forever until explicitly regenerated. Any queued/pending
   * automation job for the same viewpoint is dropped — there's nothing left
   * for the worker to do there.
   */
  async manualCapture(input: {
    buildingId?: string;
    floorNumber: number;
    direction: BalconyDirection;
    flatNumber: number;
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
    previewImageDataUrl: string;
    maskImageDataUrl?: string;
    imageWidth: number;
    imageHeight: number;
    gviScore: number;
    greenPixels: number;
    greyPixels: number;
    totalPixels: number;
  }) {
    const buildingId = input.buildingId ?? DEMO_BUILDING_ID;
    const floor = await floorRepository.findByNumber(buildingId, input.floorNumber);
    if (!floor) throw new NotFoundError("Floor", String(input.floorNumber));

    const viewpoint = await viewpointRepository.upsertSlot({
      buildingId,
      floorId: floor.id,
      direction: input.direction,
      flatNumber: input.flatNumber,
    });

    const { buffer: previewBuffer, contentType: previewContentType } = dataUrlToBuffer(input.previewImageDataUrl);
    const previewPath = await imageStorage.save(`previews/${viewpoint.id}`, previewBuffer, previewContentType);
    const capturedImage = await capturedImageRepository.create({
      viewpointId: viewpoint.id,
      imagePath: previewPath,
      width: input.imageWidth,
      height: input.imageHeight,
      contentType: previewContentType,
      byteSize: previewBuffer.byteLength,
    });

    const gviResult = await gviResultRepository.create({
      viewpointId: viewpoint.id,
      capturedImageId: capturedImage.id,
      gviScore: input.gviScore,
      greenPixels: input.greenPixels,
      greyPixels: input.greyPixels,
      totalPixels: input.totalPixels,
      processingTimeMs: null,
    });

    if (input.maskImageDataUrl) {
      const { buffer: maskBuffer, contentType: maskContentType } = dataUrlToBuffer(input.maskImageDataUrl);
      const maskPath = await imageStorage.save(`masks/${viewpoint.id}`, maskBuffer, maskContentType);
      await vegetationMaskRepository.create({
        gviResultId: gviResult.id,
        maskImagePath: maskPath,
        pixelCount: input.greenPixels,
      });
    }

    const now = new Date().toISOString();
    await viewpointRepository.saveCaptureResult(viewpoint.id, {
      previewImagePath: previewPath,
      previewCapturedAt: now,
      gvi: input.gviScore,
      greenPixels: input.greenPixels,
      greyPixels: input.greyPixels,
      analysisDate: now,
      status: "completed",
      camera: {
        longitude: input.longitude,
        latitude: input.latitude,
        height: input.height,
        heading: input.heading,
        pitch: input.pitch,
        roll: input.roll,
      },
    });

    await processingJobRepository.deletePendingForViewpoint(viewpoint.id);

    return { viewpointId: viewpoint.id };
  },

  /**
   * Overwrites stored positions with manually-verified ones from the
   * browser-local Live Balcony Position Debug tool, then enqueues a
   * regenerate job for each so the next capture actually flies to the new
   * spot instead of the generic per-floor/side/flat formula position.
   */
  async importPositions(
    positions: Array<{
      floorNumber: number;
      direction: BalconyDirection;
      flatNumber: number;
      longitude: number;
      latitude: number;
      height: number;
    }>,
    buildingId = DEMO_BUILDING_ID
  ) {
    let updated = 0;
    let notFound = 0;
    for (const position of positions) {
      const viewpoint = await viewpointRepository.findBySlotFloorNumber(
        buildingId,
        position.floorNumber,
        position.direction,
        position.flatNumber
      );
      if (!viewpoint) {
        notFound++;
        continue;
      }
      await viewpointRepository.updatePosition(viewpoint.id, position);
      await regenerateViewpoint(viewpoint.id);
      updated++;
    }
    return { updated, notFound };
  },

  /**
   * Permanently wipes a set of viewpoints' preview/GVI data (e.g. removing
   * entries from the GVI leaderboard for good) — looked up by
   * building/floor-number/direction/flat since that's all the frontend's
   * scan results know, not the backend's internal UUIDs.
   */
  async resetSlots(
    slots: Array<{ floorNumber: number; direction: BalconyDirection; flatNumber: number }>,
    buildingId = DEMO_BUILDING_ID
  ) {
    let resetCount = 0;
    let notFound = 0;
    for (const slot of slots) {
      const viewpoint = await viewpointRepository.findBySlotFloorNumber(
        buildingId,
        slot.floorNumber,
        slot.direction,
        slot.flatNumber
      );
      if (!viewpoint) {
        notFound++;
        continue;
      }
      await viewpointRepository.clearCaptureResult(viewpoint.id);
      resetCount++;
    }
    return { resetCount, notFound };
  },

  async regenerateFloorById(floorId: string) {
    const floor = await floorRepository.findById(floorId);
    if (!floor) throw new NotFoundError("Floor", floorId);
    const viewpoints = await viewpointRepository.listByBuildingAndFloor(floor.building_id, floorId);
    return regenerateFloor(viewpoints.map((v) => v.id));
  },

  async getProgress(buildingId: string) {
    const viewpoints = await viewpointRepository.listByBuilding(buildingId);
    const totalViewpoints = viewpoints.length;
    const completedViewpoints = viewpoints.filter((v) => v.status === "completed").length;
    const failedViewpoints = viewpoints.filter((v) => v.status === "failed").length;

    const jobCounts = await processingJobRepository.countByStatus();
    const runtime = getQueueRuntimeState();

    let currentJob: { jobId: string; status: string; floorNumber: number | null; direction: string; flatNumber: number } | null = null;

    if (runtime.currentJobId) {
      const { rows } = await pool.query<{
        job_id: string;
        status: string;
        floor_number: number | null;
        direction: string;
        flat_number: number;
      }>(
        `SELECT pj.id AS job_id, pj.status, f.floor_number, v.direction, v.flat_number
         FROM gv_processing_jobs pj
         JOIN gv_viewpoints v ON v.id = pj.viewpoint_id
         JOIN gv_floors f ON f.id = v.floor_id
         WHERE pj.id = $1`,
        [runtime.currentJobId]
      );
      if (rows[0]) {
        currentJob = {
          jobId: rows[0].job_id,
          status: rows[0].status,
          floorNumber: rows[0].floor_number,
          direction: rows[0].direction,
          flatNumber: rows[0].flat_number,
        };
      }
    }

    const remaining =
      (jobCounts.pending ?? 0) +
      (jobCounts.queued ?? 0) +
      (jobCounts.rendering ?? 0) +
      (jobCounts.capturing ?? 0) +
      (jobCounts.analyzing ?? 0) +
      (jobCounts.saving ?? 0);

    const estimatedTimeRemainingMs = runtime.avgJobDurationMs !== null ? Math.round(runtime.avgJobDurationMs * remaining) : null;

    return {
      totalViewpoints,
      completedViewpoints,
      failedViewpoints,
      remaining,
      isRunning: runtime.isRunning,
      isPaused: runtime.isPaused,
      currentJob,
      jobCounts,
      estimatedTimeRemainingMs,
      progressFraction: totalViewpoints > 0 ? completedViewpoints / totalViewpoints : 0,
    };
  },
};
