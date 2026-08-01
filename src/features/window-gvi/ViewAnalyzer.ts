import * as Cesium from "cesium";
import { BuildingTransform } from "../../services/camera";
import { computeEyePosition } from "./EyePositionGenerator";
import { localDirectionToWorld } from "./frame";
import { captureWindowView } from "./CapturedViewDetector";
import { castRayBatch, generateFovDirections, RayResult } from "./RayCastingEngine";
import { ClassifierContext, classifyBatch, summarizeClassCounts } from "./VegetationClassifier";
import {
  DirectionResult,
  GREEN_CLASSES,
  RayCastConfig,
  RayClassification,
  ViewDirectionName,
  WindowMetadata,
  WindowResult,
} from "./types";

// ViewAnalyzer runs the full per-window analysis: for each of the spec's
// view directions (N/S/E/W/Forward + 45L/45R), rotate the window's forward
// vector to face that direction, cast a batch of rays into that FOV cone,
// classify each hit, and roll it up into a DirectionResult. The per-window
// WindowResult then averages N/S/E/W/Forward into the headline GVI number
// (45L/45R are supplementary detail, not part of that average, since they
// overlap Forward's cone).

const LOCAL_CARDINAL: Record<"North" | "South" | "East" | "West", [number, number]> = {
  North: [0, 1],
  South: [0, -1],
  East: [1, 0],
  West: [-1, 0],
};

function directionLocalForward(
  direction: ViewDirectionName,
  windowForward: [number, number, number]
): [number, number] {
  if (direction in LOCAL_CARDINAL) {
    return LOCAL_CARDINAL[direction as keyof typeof LOCAL_CARDINAL];
  }
  const [fe, fn] = [windowForward[0], windowForward[1]];
  if (direction === "Forward") return [fe, fn];

  const angle = direction === "Left45" ? -Math.PI / 4 : Math.PI / 4;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [fe * cos - fn * sin, fe * sin + fn * cos];
}

export async function analyzeWindow(
  scene: Cesium.Scene,
  building: BuildingTransform,
  window: WindowMetadata,
  floorFootHeightLocalUp: number,
  directions: ViewDirectionName[],
  config: RayCastConfig,
  context: ClassifierContext,
  onProgress?: (direction: ViewDirectionName, done: number, total: number) => void,
  include360 = false,
  onDirectionRaysCast?: (
    direction: ViewDirectionName,
    origin: Cesium.Cartesian3,
    hits: RayResult[],
    classifications: RayClassification[]
  ) => void,
  /** When provided (and captureView is true), also renders the eye's
   * Forward view and classifies the actual rendered pixels — see
   * CapturedViewDetector.ts. Requires the full Viewer (camera control),
   * not just the Scene used for ray casting. */
  viewerForCapture?: Cesium.Viewer,
  captureView = false
): Promise<WindowResult> {
  const eye = computeEyePosition(building, window, floorFootHeightLocalUp);
  const directionResults: DirectionResult[] = [];

  for (const direction of directions) {
    const [localEast, localNorth] = directionLocalForward(direction, eye.forward);
    const worldForward = localDirectionToWorld(
      building,
      eye.worldPosition,
      localEast,
      localNorth,
      0
    );
    const worldUp = localDirectionToWorld(building, eye.worldPosition, 0, 0, 1);

    const rayDirections = generateFovDirections(
      worldForward,
      worldUp,
      config.rayCount,
      config.horizontalFovDeg,
      config.verticalFovDeg
    );

    const hits = await castRayBatch(
      scene,
      eye.worldPosition,
      rayDirections,
      (done, total) => onProgress?.(direction, done, total)
    );

    const classifications = classifyBatch(hits, context);
    onDirectionRaysCast?.(direction, eye.worldPosition, hits, classifications);
    const classCounts = summarizeClassCounts(classifications);
    const greenRays = GREEN_CLASSES.reduce((sum, c) => sum + classCounts[c], 0);
    const totalRays = hits.length;

    directionResults.push({
      direction,
      totalRays,
      greenRays,
      gviPercent: totalRays > 0 ? (greenRays / totalRays) * 100 : 0,
      classCounts,
    });
  }

  const headline = directionResults.filter((d) =>
    (["North", "South", "East", "West", "Forward"] as ViewDirectionName[]).includes(d.direction)
  );
  const averageGviPercent =
    headline.length > 0
      ? headline.reduce((sum, d) => sum + d.gviPercent, 0) / headline.length
      : 0;

  let average360GviPercent: number | undefined;
  if (include360) {
    // Sample 8 bearings 45° apart, each with its own FOV cone, and average
    // — a coarse but real full-rotation sweep rather than reusing the
    // cardinal directions (which only cover 4 of the 8 headings).
    const SWEEP_BEARINGS = 8;
    let sum = 0;
    for (let i = 0; i < SWEEP_BEARINGS; i++) {
      const bearing = (i / SWEEP_BEARINGS) * 2 * Math.PI;
      const localEast = Math.sin(bearing);
      const localNorth = Math.cos(bearing);
      const worldForward = localDirectionToWorld(
        building,
        eye.worldPosition,
        localEast,
        localNorth,
        0
      );
      const worldUp = localDirectionToWorld(building, eye.worldPosition, 0, 0, 1);
      const rayDirections = generateFovDirections(
        worldForward,
        worldUp,
        config.rayCount,
        config.horizontalFovDeg,
        config.verticalFovDeg
      );
      const hits = await castRayBatch(scene, eye.worldPosition, rayDirections, (done, total) =>
        onProgress?.("Forward", done, total)
      );
      const classifications = classifyBatch(hits, context);
      const counts = summarizeClassCounts(classifications);
      const green = GREEN_CLASSES.reduce((s, c) => s + counts[c], 0);
      sum += hits.length > 0 ? (green / hits.length) * 100 : 0;
    }
    average360GviPercent = sum / SWEEP_BEARINGS;
  }

  let capturedViewGviPercent: number | undefined;
  let capturedViewDataUrl: string | undefined;
  if (captureView && viewerForCapture) {
    try {
      const captured = await captureWindowView(viewerForCapture, eye, building);
      capturedViewGviPercent = captured.gviPercent;
      capturedViewDataUrl = captured.dataUrl;
    } catch (err) {
      // Non-fatal: ray-based results are still valid without this cross-check.
      console.warn("[Window GVI] Captured-view detection failed", window.id, err);
    }
  }

  const eyeCarto = Cesium.Cartographic.fromCartesian(eye.worldPosition);

  return {
    windowId: window.id,
    floor: window.floor,
    flat: window.flat,
    room: window.room,
    eyeHeightM: eye.eyeHeightM,
    eyePosition: {
      latitude: Cesium.Math.toDegrees(eyeCarto.latitude),
      longitude: Cesium.Math.toDegrees(eyeCarto.longitude),
      height: eyeCarto.height,
    },
    directions: directionResults,
    averageGviPercent,
    average360GviPercent,
    capturedViewGviPercent,
    capturedViewDataUrl,
    analyzedAtIso: new Date().toISOString(),
  };
}
