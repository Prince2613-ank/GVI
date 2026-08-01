import * as Cesium from "cesium";

// Shared type surface for the whole window-gvi feature. Kept in one file so
// every module (WindowManager, RayCastingEngine, GVIEngine, UI...) imports
// from a single source of truth instead of re-declaring shapes.

/** A single window, in the building's local frame (see frame.ts). */
export interface WindowMetadata {
  id: string;
  floor: number;
  flat: string;
  room: string;
  /** Local [east, north, up] offset in meters from the building's origin. */
  position: [number, number, number];
  /** Local [east, north, up] outward-facing normal (need not be unit length). */
  normal: [number, number, number];
  width: number;
  height: number;
  /** "json" if loaded from metadata, "auto" if detected from the GLB mesh. */
  source: "json" | "auto";
}

export const VIEW_DIRECTIONS = [
  "North",
  "South",
  "East",
  "West",
  "Forward",
  "Left45",
  "Right45",
] as const;
export type ViewDirectionName = (typeof VIEW_DIRECTIONS)[number];

export interface EyePosition {
  windowId: string;
  /** World-space Cartesian3 the eye ray-casts from. */
  worldPosition: Cesium.Cartesian3;
  /** Local [east, north, up] forward vector the window faces. */
  forward: [number, number, number];
  eyeHeightM: number;
}

export type GreenClass = "tree" | "grass" | "bush" | "park";
export type NonGreenClass = "building" | "road" | "water" | "sky" | "unknown";
export type SurfaceClass = GreenClass | NonGreenClass;

export const GREEN_CLASSES: readonly GreenClass[] = ["tree", "grass", "bush", "park"];

export interface RayClassification {
  classSurface: SurfaceClass;
  isGreen: boolean;
  distanceM: number | null;
}

export interface DirectionResult {
  direction: ViewDirectionName;
  totalRays: number;
  greenRays: number;
  gviPercent: number;
  classCounts: Record<SurfaceClass, number>;
}

export interface WindowResult {
  windowId: string;
  floor: number;
  flat: string;
  room: string;
  eyeHeightM: number;
  eyePosition: { latitude: number; longitude: number; height: number };
  directions: DirectionResult[];
  /** Average of North/South/East/West/Forward GVI (the headline number). */
  averageGviPercent: number;
  /** Average GVI across a full 360° bearing sweep, if requested. */
  average360GviPercent?: number;
  /**
   * GVI measured from the ACTUAL rendered pixels of the captured view
   * (camera moved to the eye position, looking Forward) — a real-visuals
   * cross-check against the ray-based averageGviPercent, since it picks up
   * whatever is genuinely on screen (rendered tree crowns, canopy
   * material, imagery) rather than only what canopy-polygon ray hits
   * report. Present only when capture-view detection was requested.
   */
  capturedViewGviPercent?: number;
  capturedViewDataUrl?: string;
  analyzedAtIso: string;
}

export interface RoomResult {
  room: string;
  floor: number;
  flat: string;
  windowIds: string[];
  averageGviPercent: number;
}

export interface FlatResult {
  flat: string;
  floor: number;
  roomIds: string[];
  averageGviPercent: number;
}

export interface FloorResult {
  floor: number;
  flatIds: string[];
  averageGviPercent: number;
}

export interface BuildingGviResult {
  floors: FloorResult[];
  averageGviPercent: number;
}

export interface RayCastConfig {
  /** Rays per direction. Real Cesium ray-scene picks are not free — see
   * RayCastingEngine's comment for the perf trade-off; keep this modest. */
  rayCount: number;
  horizontalFovDeg: number;
  verticalFovDeg: number;
}

export const DEFAULT_RAY_CAST_CONFIG: RayCastConfig = {
  rayCount: 96,
  horizontalFovDeg: 90,
  verticalFovDeg: 60,
};
