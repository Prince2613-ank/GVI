export type BalconyDirection = "North" | "South" | "East" | "West";

export type ProcessingJobStatus =
  | "pending" | "queued" | "rendering" | "capturing" | "analyzing" | "saving"
  | "completed" | "failed";

export interface GvBuilding {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  height: number;
  rotation_rad: number;
  scale: number;
  created_at: string;
  updated_at: string;
}

export interface GvFloor {
  id: string;
  building_id: string;
  floor_number: number;
  name: string;
  created_at: string;
}

export interface GvViewpoint {
  id: string;
  building_id: string;
  floor_id: string;
  room: string | null;
  direction: BalconyDirection;
  flat_number: number;
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
  preview_image_path: string | null;
  preview_captured_at: string | null;
  gvi: string | null;
  green_pixels: string | null;
  grey_pixels: string | null;
  analysis_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface GvCapturedImage {
  id: string;
  viewpoint_id: string;
  image_path: string;
  width: number;
  height: number;
  content_type: string;
  byte_size: number | null;
  captured_at: string;
  created_at: string;
}

export interface GvGviResult {
  id: string;
  viewpoint_id: string;
  captured_image_id: string | null;
  gvi_score: string;
  green_pixels: string;
  grey_pixels: string;
  total_pixels: string;
  processing_time_ms: number | null;
  thresholds_used: Record<string, unknown> | null;
  computed_at: string;
}

export interface GvVegetationMask {
  id: string;
  gvi_result_id: string;
  mask_image_path: string;
  pixel_count: string;
  created_at: string;
}

export interface GvProcessingJob {
  id: string;
  viewpoint_id: string;
  status: ProcessingJobStatus;
  attempt: number;
  max_attempts: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}
