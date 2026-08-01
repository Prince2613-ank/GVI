// Thin client for the standalone Green View backend's automated
// balcony-viewpoint-generation API (cesium-demo/backend — its own service,
// separate from the digital-twin admin backend in /backend, sharing only
// the same Postgres database via gv_-prefixed tables). Read-only endpoints
// (viewpoints, viewpoint/:id, progress) need no auth; the admin-only
// generation controls (start/pause/resume/cancel/retry/regenerate) require
// a shared-secret bearer token — set the SAME value in cesium-demo/backend/.env
// as ADMIN_TOKEN and here as VITE_BALCONY_ADMIN_TOKEN.

const API_BASE =
  (import.meta.env.VITE_BALCONY_API_URL as string | undefined) ??
  "http://localhost:4100/api/balcony-viewpoints";
const ADMIN_TOKEN = import.meta.env.VITE_BALCONY_ADMIN_TOKEN as string | undefined;

export interface RemoteViewpoint {
  id: string;
  buildingId: string;
  floorId: string;
  floorNumber: number | null;
  room: string | null;
  direction: "North" | "South" | "East" | "West";
  flatNumber: number;
  camera: {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
  };
  previewImageUrl: string | null;
  previewCapturedAt: string | null;
  gvi: number | null;
  greenPixels: number | null;
  greyPixels: number | null;
  analysisDate: string | null;
  status: string;
}

export interface GenerationProgress {
  totalViewpoints: number;
  completedViewpoints: number;
  failedViewpoints: number;
  remaining: number;
  isRunning: boolean;
  isPaused: boolean;
  currentJob: {
    jobId: string;
    status: string;
    floorNumber: number | null;
    direction: string;
    flatNumber: number;
  } | null;
  jobCounts: Record<string, number>;
  estimatedTimeRemainingMs: number | null;
  progressFraction: number;
}

function resolveMediaUrl(path: string): string {
  // previewImageUrl comes back as a relative "/api/balcony-viewpoints/media/..."
  // path from the backend — resolve it against the same origin the API lives on.
  if (path.startsWith("http")) return path;
  const apiOrigin = new URL(API_BASE).origin;
  return `${apiOrigin}${path}`;
}

async function request<T>(path: string, options: { method?: string; body?: unknown; admin?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.admin && ADMIN_TOKEN) headers.Authorization = `Bearer ${ADMIN_TOKEN}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Balcony generation API ${path} failed (${response.status}): ${text}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

// buildingId is optional everywhere below — the backend defaults to its one
// seeded demo building (matching cesium-demo's hardcoded INITIAL_BUILDING)
// when omitted, so there's no building-picker UI to wire up for this single-
// building demo.

export async function fetchViewpoints(buildingId?: string, floorId?: string): Promise<RemoteViewpoint[]> {
  const query = new URLSearchParams({
    ...(buildingId ? { buildingId } : {}),
    ...(floorId ? { floorId } : {}),
  });
  const { viewpoints } = await request<{ viewpoints: RemoteViewpoint[] }>(`/viewpoints?${query}`);
  return viewpoints.map((v) => ({
    ...v,
    previewImageUrl: v.previewImageUrl ? resolveMediaUrl(v.previewImageUrl) : null,
  }));
}

export async function fetchProgress(buildingId?: string): Promise<GenerationProgress> {
  const query = buildingId ? `?${new URLSearchParams({ buildingId })}` : "";
  return request<GenerationProgress>(`/progress${query}`);
}

export function startGeneration(buildingId?: string): Promise<{ enqueued: number; skippedCompleted: number }> {
  return request(`/start-generation`, { method: "POST", body: buildingId ? { buildingId } : {}, admin: true });
}

export function pauseGeneration(): Promise<{ isPaused: boolean }> {
  return request(`/pause`, { method: "POST", admin: true });
}

export function resumeGeneration(): Promise<{ isPaused: boolean }> {
  return request(`/resume`, { method: "POST", admin: true });
}

export function cancelGeneration(): Promise<{ cancelledCount: number }> {
  return request(`/cancel`, { method: "POST", admin: true });
}

export function retryFailedJobs(): Promise<{ requeuedCount: number }> {
  return request(`/retry-failed`, { method: "POST", admin: true });
}

export function regenerateViewpoint(id: string): Promise<{ job: unknown }> {
  return request(`/regenerate/${id}`, { method: "POST", admin: true });
}

export function regenerateFloor(floorId: string): Promise<{ enqueuedCount: number }> {
  return request(`/regenerate-floor/${floorId}`, { method: "POST", admin: true });
}

export interface ManualPositionSync {
  floorNumber: number;
  direction: "North" | "South" | "East" | "West";
  flatNumber: number;
  longitude: number;
  latitude: number;
  height: number;
}

/**
 * Pushes manually-verified camera positions (from the Live Balcony Position
 * Debug tool's saved collection) into the backend, overwriting each matching
 * viewpoint's stored position and re-queuing it for capture — this is what
 * makes the automated pipeline actually fly to the SAME spot you fine-tuned
 * by hand, instead of a generic per-floor/side/flat formula guess.
 */
export function importPositions(positions: ManualPositionSync[]): Promise<{ updated: number; notFound: number }> {
  return request(`/import-positions`, { method: "POST", body: { positions }, admin: true });
}

export interface ResetSlot {
  floorNumber: number;
  direction: "North" | "South" | "East" | "West";
  flatNumber: number;
}

/**
 * Permanently wipes a viewpoint's preview/GVI data (used to delete entries
 * from the GVI leaderboard/ranking for good) — the slot itself stays so it
 * can be re-captured/re-scanned later, only the stored analysis is cleared.
 */
export function resetSlots(slots: ResetSlot[]): Promise<{ resetCount: number; notFound: number }> {
  return request(`/reset-slots`, { method: "POST", body: { slots }, admin: true });
}

export interface ManualCaptureInput {
  floorNumber: number;
  direction: "North" | "South" | "East" | "West";
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
}

/**
 * Stores a screenshot you just captured live (via "Save Point" in the Live
 * Balcony Position Debug tool) directly as that viewpoint's permanent
 * backend record — no automation job, no waiting for the Puppeteer queue.
 * Reused forever until explicitly regenerated.
 */
export function manualCapture(input: ManualCaptureInput): Promise<{ viewpointId: string }> {
  return request(`/manual-capture`, { method: "POST", body: input, admin: true });
}
