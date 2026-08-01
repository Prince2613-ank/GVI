import * as Cesium from "cesium";
import { BuildingTransform } from "../../services/camera";

// Every window position/normal is authored in the building's LOCAL frame:
// [east, north, up] meters/components relative to the building's own
// pre-rotation orientation (the same convention services/camera.ts's
// facadeLocalOffset already uses for facade math elsewhere in this app).
// This file is the single place that turns a local offset into a world
// Cartesian3 or a world-space direction vector, so every other module
// (EyePositionGenerator, ViewAnalyzer, WindowOverlay) transforms consistently.

export function localOffsetToWorldPosition(
  building: BuildingTransform,
  localEast: number,
  localNorth: number,
  localUp: number
): Cesium.Cartesian3 {
  const cosR = Math.cos(building.rotationRad);
  const sinR = Math.sin(building.rotationRad);
  const worldEast = localEast * cosR - localNorth * sinR;
  const worldNorth = localEast * sinR + localNorth * cosR;

  const origin = Cesium.Cartesian3.fromDegrees(
    building.longitude,
    building.latitude,
    building.height
  );
  const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  return Cesium.Matrix4.multiplyByPoint(
    enuTransform,
    new Cesium.Cartesian3(worldEast, worldNorth, localUp),
    new Cesium.Cartesian3()
  );
}

/** Same rotation as localOffsetToWorldPosition, but for a direction vector
 * (no translation, and it's re-derived per-eye-position ENU frame so it
 * stays correct as the building moves). */
export function localDirectionToWorld(
  building: BuildingTransform,
  eyeWorldPosition: Cesium.Cartesian3,
  localEast: number,
  localNorth: number,
  localUp: number
): Cesium.Cartesian3 {
  const cosR = Math.cos(building.rotationRad);
  const sinR = Math.sin(building.rotationRad);
  const worldEast = localEast * cosR - localNorth * sinR;
  const worldNorth = localEast * sinR + localNorth * cosR;

  const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(eyeWorldPosition);
  const enuRotation = Cesium.Matrix4.getMatrix3(enuTransform, new Cesium.Matrix3());
  const direction = Cesium.Matrix3.multiplyByVector(
    enuRotation,
    new Cesium.Cartesian3(worldEast, worldNorth, localUp),
    new Cesium.Cartesian3()
  );
  return Cesium.Cartesian3.normalize(direction, direction);
}
