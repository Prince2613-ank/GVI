import { BuildingTransform } from "../../services/camera";
import { localOffsetToWorldPosition } from "./frame";
import { EyePosition, WindowMetadata } from "./types";

// Turns a window's authored position/normal into a concrete eye position:
// window center, pushed 0.5m inward (opposite the outward normal) into the
// room, at a human eye height of 1.6m above the floor the window sits on
// (not the window's own possibly off-center vertical position, since real
// occupants stand on the floor, not float at window height).

const INWARD_OFFSET_M = 0.5;
export const EYE_HEIGHT_ABOVE_FLOOR_M = 1.6;

function normalize3(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function computeEyePosition(
  building: BuildingTransform,
  window: WindowMetadata,
  floorFootHeightLocalUp: number
): EyePosition {
  const forward = normalize3(window.normal);
  const [east, north, up] = window.position;

  const eyeLocalEast = east - forward[0] * INWARD_OFFSET_M;
  const eyeLocalNorth = north - forward[1] * INWARD_OFFSET_M;
  // Eye height is anchored to the floor plate the window belongs to, not
  // the window's own (possibly sill-level or lintel-level) up coordinate.
  const eyeLocalUp = floorFootHeightLocalUp + EYE_HEIGHT_ABOVE_FLOOR_M;
  void up;

  const worldPosition = localOffsetToWorldPosition(
    building,
    eyeLocalEast,
    eyeLocalNorth,
    eyeLocalUp
  );

  return {
    windowId: window.id,
    worldPosition,
    forward,
    eyeHeightM: EYE_HEIGHT_ABOVE_FLOOR_M,
  };
}
