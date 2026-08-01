import * as Cesium from "cesium";
import { CardinalDirection } from "../utils/constants";
import {
  BUILDING_HALF_DEPTH_M,
  BUILDING_HALF_WIDTH_M,
  EYE_HEIGHT_M,
  FLOOR_HEIGHT_M,
  MODEL_BASE_OFFSET_M,
  WINDOW_CAMERA_OFFSET_M,
} from "../utils/constants";
import { computeCameraHeightM, computeOutwardHeadingRad } from "../utils/cameraUtils";

// camera.ts owns all camera mathematics: converting a (floor, window
// direction) selection into a concrete Cesium camera pose that sits just
// outside the building facade and looks outward.

export interface BuildingTransform {
  latitude: number;
  longitude: number;
  height: number;
  rotationRad: number;
  scale: number;
}

export interface WindowCameraPose {
  position: Cesium.Cartesian3;
  heading: number;
  pitch: number;
  roll: number;
  cameraHeightM: number;
}

/**
 * A floor plate typically holds multiple units, each with its own
 * window/balcony at a different point along a facade — not just one point
 * dead-center. These let the interactive view sample any point along the
 * chosen facade and look out at any angle, instead of only the facade's
 * exact midpoint looking perfectly perpendicular.
 */
export interface ViewpointOptions {
  /** -1 (one corner) to 1 (the other corner) along the facade; 0 = center. */
  facadeOffsetRatio?: number;
  /** Yaw added to the facade's straight-outward heading, in radians. */
  headingOffsetRad?: number;
  /** Camera pitch in radians; 0 = level with the horizon. */
  pitchRad?: number;
  /** Distance (meters) to stand back from the facade — defaults to WINDOW_CAMERA_OFFSET_M (right at the window). A larger value pulls back to an outside overview shot instead. */
  pushOverrideM?: number;
}

/**
 * Local ENU offset (meters) from the building center to a point along a
 * facade's window plane. Exported so App.tsx's window-highlight marker can
 * share this exact math instead of re-deriving it (a previous duplicate
 * copy in App.tsx was a source of drift bugs).
 */
export function facadeLocalOffset(
  direction: CardinalDirection,
  scale: number,
  facadeOffsetRatio = 0,
  pushOverrideM?: number
): { east: number; north: number } {
  const halfWidth = BUILDING_HALF_WIDTH_M * scale;
  const halfDepth = BUILDING_HALF_DEPTH_M * scale;
  const push = pushOverrideM ?? WINDOW_CAMERA_OFFSET_M;
  const ratio = Cesium.Math.clamp(facadeOffsetRatio, -1, 1);

  switch (direction) {
    case "North":
      return { east: ratio * halfWidth, north: halfDepth + push };
    case "South":
      return { east: ratio * halfWidth, north: -(halfDepth + push) };
    case "East":
      return { east: halfWidth + push, north: ratio * halfDepth };
    case "West":
      return { east: -(halfWidth + push), north: ratio * halfDepth };
  }
}

/**
 * Computes the world-space camera position and orientation for a given
 * floor + window direction, relative to the building's current transform.
 * `viewpoint` optionally moves the sample point along the facade and/or
 * rotates the look angle away from straight-outward/level.
 *
 * The building entity's placement point (building.height above the
 * ellipsoid/terrain) is NOT the same as the model's visual ground floor —
 * the GLB's own origin sits MODEL_BASE_OFFSET_M below its lowest vertex, so
 * that offset (scaled with the building) must be added before floor*height
 * math lines up with the actual rendered facade.
 */
export function computeWindowCameraPose(
  building: BuildingTransform,
  floor: number,
  direction: CardinalDirection,
  viewpoint: ViewpointOptions = {}
): WindowCameraPose {
  const { facadeOffsetRatio = 0, headingOffsetRad = 0, pitchRad = 0, pushOverrideM } = viewpoint;

  const baseOffsetM = MODEL_BASE_OFFSET_M * building.scale;
  const cameraHeightM =
    baseOffsetM + computeCameraHeightM(floor, FLOOR_HEIGHT_M, EYE_HEIGHT_M);
  const heading = computeOutwardHeadingRad(building.rotationRad, direction) + headingOffsetRad;

  const { east: localEast, north: localNorth } = facadeLocalOffset(
    direction,
    building.scale,
    facadeOffsetRatio,
    pushOverrideM
  );

  // Rotate the local facade offset by the building's rotation to get the
  // true east/north offset in world ENU space.
  const cosR = Math.cos(building.rotationRad);
  const sinR = Math.sin(building.rotationRad);
  const worldEast = localEast * cosR - localNorth * sinR;
  const worldNorth = localEast * sinR + localNorth * cosR;

  const buildingOrigin = Cesium.Cartesian3.fromDegrees(
    building.longitude,
    building.latitude,
    building.height
  );

  const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(buildingOrigin);
  const localOffset = new Cesium.Cartesian3(worldEast, worldNorth, cameraHeightM);
  const position = Cesium.Matrix4.multiplyByPoint(
    enuTransform,
    localOffset,
    new Cesium.Cartesian3()
  );

  return {
    position,
    heading,
    pitch: pitchRad,
    roll: 0,
    cameraHeightM,
  };
}

/** How far outside the facade the floor-overview shot stands back, in meters — enough to frame the whole floor band, not just one window. */
const FLOOR_OVERVIEW_PULLBACK_M = 45;

/**
 * A pulled-back OUTSIDE shot of an entire floor, facing straight in at the
 * building — used by the fly-through building tour (and available for a
 * Floor-button click to jump straight there too), distinct from
 * computeWindowCameraPose's close-up, look-outward balcony pose used once
 * you've picked a specific saved viewpoint and gone inside.
 */
export function computeFloorOverviewPose(
  building: BuildingTransform,
  floor: number,
  direction: CardinalDirection = "North"
): WindowCameraPose {
  return computeWindowCameraPose(building, floor, direction, {
    pushOverrideM: FLOOR_OVERVIEW_PULLBACK_M,
    // Standing outside looking straight in at the building, not outward
    // through the window — the opposite heading from the indoor viewpoint.
    headingOffsetRad: Math.PI,
    pitchRad: Cesium.Math.toRadians(-8),
  });
}

/**
 * Flies the camera smoothly to a computed pose (used for interactive
 * floor/window selection). Resolves once the flight completes so callers
 * can wait before capturing a frame — invokes immediately if the viewer is
 * already effectively at the destination.
 */
export function flyCameraToPose(
  viewer: Cesium.Viewer,
  pose: WindowCameraPose,
  durationSeconds = 1.2
): Promise<void> {
  return new Promise((resolve) => {
    viewer.camera.flyTo({
      destination: pose.position,
      orientation: {
        heading: pose.heading,
        pitch: pose.pitch,
        roll: pose.roll,
      },
      duration: durationSeconds,
      complete: () => resolve(),
      cancel: () => resolve(),
    });
  });
}

/**
 * Snaps the camera to a computed pose instantly, with no flight animation.
 * Used by the full-building GVI profile scan, where dozens of poses are
 * visited in sequence and an animated flight per pose would be far too slow.
 */
export function setCameraToPoseInstant(
  viewer: Cesium.Viewer,
  pose: WindowCameraPose
): void {
  viewer.camera.setView({
    destination: pose.position,
    orientation: {
      heading: pose.heading,
      pitch: pose.pitch,
      roll: pose.roll,
    },
  });
}
