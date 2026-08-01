import { viewpointRepository } from "../../repositories/viewpointRepository";
import { floorRepository } from "../../repositories/floorRepository";
import { processingJobRepository } from "../../repositories/processingJobRepository";
import { capturedImageRepository } from "../../repositories/capturedImageRepository";
import { gviResultRepository } from "../../repositories/gviResultRepository";
import { vegetationMaskRepository } from "../../repositories/vegetationMaskRepository";
import { imageStorage } from "../storage";
import { captureViewpoint } from "./puppeteerDriver";
import { discoverViewpointsForBuilding } from "./viewpointDiscovery";
import { GvProcessingJob } from "../../types";

interface QueueState {
  isRunning: boolean;
  isPaused: boolean;
  currentJobId: string | null;
  jobDurationsMs: number[];
}

const state: QueueState = { isRunning: false, isPaused: false, currentJobId: null, jobDurationsMs: [] };
const MAX_TRACKED_DURATIONS = 20;

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; contentType: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("Malformed data URL from automation harness");
  return { buffer: Buffer.from(match[2], "base64"), contentType: match[1] };
}

async function processJob(job: GvProcessingJob): Promise<void> {
  const startedAt = Date.now();
  state.currentJobId = job.id;

  const viewpoint = await viewpointRepository.findById(job.viewpoint_id);
  if (!viewpoint) {
    await processingJobRepository.setStatus(job.id, "failed", "Viewpoint no longer exists");
    state.currentJobId = null;
    return;
  }

  const floor = await floorRepository.findById(viewpoint.floor_id);
  if (!floor) {
    await processingJobRepository.setStatus(job.id, "failed", "Floor no longer exists");
    await viewpointRepository.setStatus(viewpoint.id, "failed");
    state.currentJobId = null;
    return;
  }

  try {
    await processingJobRepository.setStatus(job.id, "rendering");
    await viewpointRepository.setStatus(viewpoint.id, "rendering");

    // A viewpoint still at its discovery-time (0,0,0) placeholder has never
    // been captured or manually synced — let the harness compute its
    // default formula position. Anything else (a previous capture's
    // resolved position, OR a manually-verified position synced in via
    // /import-positions) is passed through as an explicit override so the
    // harness flies to EXACTLY that spot instead of recomputing generically.
    const hasRealPosition = viewpoint.longitude !== 0 || viewpoint.latitude !== 0;
    const capture = await captureViewpoint({
      floor: floor.floor_number,
      direction: viewpoint.direction,
      flat: viewpoint.flat_number,
      overridePosition: hasRealPosition
        ? { longitude: viewpoint.longitude, latitude: viewpoint.latitude, height: viewpoint.height }
        : undefined,
    });

    await processingJobRepository.setStatus(job.id, "capturing");
    await viewpointRepository.setStatus(viewpoint.id, "capturing");

    if (!capture.previewImageDataUrl || !capture.width || !capture.height) {
      throw new Error("Automation harness did not return a preview image");
    }
    const { buffer: previewBuffer, contentType: previewContentType } = dataUrlToBuffer(capture.previewImageDataUrl);
    const previewPath = await imageStorage.save(`previews/${viewpoint.id}`, previewBuffer, previewContentType);
    const capturedImage = await capturedImageRepository.create({
      viewpointId: viewpoint.id,
      imagePath: previewPath,
      width: capture.width,
      height: capture.height,
      contentType: previewContentType,
      byteSize: previewBuffer.byteLength,
    });

    await processingJobRepository.setStatus(job.id, "analyzing");
    await viewpointRepository.setStatus(viewpoint.id, "analyzing");

    const gviScore = capture.gviScore ?? 0;
    const greenPixels = capture.greenPixelCount ?? 0;
    const greyPixels = capture.greyPixelCount ?? 0;
    const totalPixels = capture.totalPixelCount ?? greenPixels + greyPixels;

    const gviResult = await gviResultRepository.create({
      viewpointId: viewpoint.id,
      capturedImageId: capturedImage.id,
      gviScore,
      greenPixels,
      greyPixels,
      totalPixels,
      processingTimeMs: Date.now() - startedAt,
    });

    if (capture.maskImageDataUrl) {
      const { buffer: maskBuffer, contentType: maskContentType } = dataUrlToBuffer(capture.maskImageDataUrl);
      const maskPath = await imageStorage.save(`masks/${viewpoint.id}`, maskBuffer, maskContentType);
      await vegetationMaskRepository.create({ gviResultId: gviResult.id, maskImagePath: maskPath, pixelCount: greenPixels });
    }

    await processingJobRepository.setStatus(job.id, "saving");
    await viewpointRepository.setStatus(viewpoint.id, "saving");

    await viewpointRepository.saveCaptureResult(viewpoint.id, {
      previewImagePath: previewPath,
      previewCapturedAt: new Date().toISOString(),
      gvi: gviScore,
      greenPixels,
      greyPixels,
      analysisDate: new Date().toISOString(),
      status: "completed",
      camera: capture.camera,
    });

    await processingJobRepository.setStatus(job.id, "completed");

    const durationMs = Date.now() - startedAt;
    state.jobDurationsMs.push(durationMs);
    if (state.jobDurationsMs.length > MAX_TRACKED_DURATIONS) state.jobDurationsMs.shift();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const updatedJob = await processingJobRepository.incrementAttempt(job.id);
    const attempt = updatedJob?.attempt ?? job.attempt + 1;
    if (attempt < job.max_attempts) {
      await processingJobRepository.setStatus(job.id, "queued", message);
    } else {
      await processingJobRepository.setStatus(job.id, "failed", message);
      await viewpointRepository.setStatus(viewpoint.id, "failed");
    }
  } finally {
    state.currentJobId = null;
  }
}

async function runLoop(): Promise<void> {
  if (state.isRunning) return;
  state.isRunning = true;
  try {
    while (!state.isPaused) {
      const job = await processingJobRepository.findNextPending();
      if (!job) break;
      await processJob(job);
    }
  } finally {
    state.isRunning = false;
  }
}

export function ensureWorkerRunning(): void {
  state.isPaused = false;
  if (!state.isRunning) void runLoop();
}

export function pauseGeneration(): void {
  state.isPaused = true;
}

export function resumeGeneration(): void {
  ensureWorkerRunning();
}

export async function cancelGeneration(): Promise<number> {
  state.isPaused = true;
  const pending = await processingJobRepository.listByStatus("pending");
  const queued = await processingJobRepository.listByStatus("queued");
  const toCancel = [...pending, ...queued];
  for (const job of toCancel) {
    await processingJobRepository.setStatus(job.id, "failed", "Cancelled by user");
  }
  return toCancel.length;
}

export async function retryFailedJobs(): Promise<number> {
  const failed = await processingJobRepository.listByStatus("failed");
  for (const job of failed) await processingJobRepository.requeue(job.id);
  if (failed.length > 0) ensureWorkerRunning();
  return failed.length;
}

export async function startGeneration(buildingId: string): Promise<{ enqueued: number; skippedCompleted: number }> {
  const viewpointIds = await discoverViewpointsForBuilding(buildingId);
  let enqueued = 0;
  let skippedCompleted = 0;

  for (const viewpointId of viewpointIds) {
    const viewpoint = await viewpointRepository.findById(viewpointId);
    if (!viewpoint) continue;

    if (viewpoint.status === "completed" && viewpoint.preview_image_path) {
      skippedCompleted++;
      continue;
    }

    const latestJob = await processingJobRepository.findLatestByViewpoint(viewpointId);
    if (latestJob && !["completed", "failed"].includes(latestJob.status)) continue;

    await processingJobRepository.create(viewpointId);
    enqueued++;
  }

  ensureWorkerRunning();
  return { enqueued, skippedCompleted };
}

/** Reuses an already-queued/in-flight job for this viewpoint instead of creating a duplicate — repeated regenerate/sync calls must not pile up the queue. */
async function createOrReuseJob(viewpointId: string): Promise<GvProcessingJob> {
  const latestJob = await processingJobRepository.findLatestByViewpoint(viewpointId);
  if (latestJob && !["completed", "failed"].includes(latestJob.status)) return latestJob;
  return processingJobRepository.create(viewpointId);
}

export async function regenerateViewpoint(viewpointId: string): Promise<GvProcessingJob> {
  const job = await createOrReuseJob(viewpointId);
  ensureWorkerRunning();
  return job;
}

export async function regenerateFloor(viewpointIds: string[]): Promise<number> {
  for (const id of viewpointIds) await createOrReuseJob(id);
  ensureWorkerRunning();
  return viewpointIds.length;
}

export function getQueueRuntimeState() {
  const avgDurationMs =
    state.jobDurationsMs.length > 0
      ? state.jobDurationsMs.reduce((a, b) => a + b, 0) / state.jobDurationsMs.length
      : null;
  return {
    isRunning: state.isRunning,
    isPaused: state.isPaused,
    currentJobId: state.currentJobId,
    avgJobDurationMs: avgDurationMs,
  };
}

/** Crash recovery: reset any job stuck mid-flight, then keep going if there's unfinished work — "never restart entire building." */
export async function resumeUnfinishedOnBoot(): Promise<void> {
  await processingJobRepository.resetInFlightToQueued();
  const unfinished = await processingJobRepository.listUnfinished();
  if (unfinished.length > 0) ensureWorkerRunning();
}
