export interface CapturedViewCamera {
  longitude: number;
  latitude: number;
  height: number;
  /** Degrees. */
  heading: number;
  /** Degrees. */
  pitch: number;
  /** Degrees. */
  roll: number;
}

export interface CapturedView {
  id: string;
  /** Full-resolution PNG data URL of the Cesium canvas at capture time. */
  image: string;
  width: number;
  height: number;
  timestamp: number;
  camera: CapturedViewCamera;
  /**
   * Manual vegetation polygons (features/manual-vegetation) projected into
   * this exact frame at the moment it was captured — computed then, not at
   * analyze time, since that's the only moment the live camera actually
   * matches what's in `image`. 0/1 per pixel, row-major, same width/height
   * as this capture. Absent if there were no manual polygons to project.
   */
  manualVegetationMask?: { width: number; height: number; data: Uint8Array; pixelCount: number };
}

export type CaptureStatus = "idle" | "capturing" | "success" | "error";
