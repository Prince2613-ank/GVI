import { CardinalDirection, DIRECTION_HEADING_RAD } from "./constants";

/**
 * Combines a building's own rotation with the facade direction to produce
 * the absolute heading (radians) the window camera should face, looking
 * outward away from the building.
 */
export function computeOutwardHeadingRad(
  buildingRotationRad: number,
  direction: CardinalDirection
): number {
  const facadeHeading = DIRECTION_HEADING_RAD[direction];
  return normalizeRadians(buildingRotationRad + facadeHeading);
}

export function normalizeRadians(rad: number): number {
  const twoPi = Math.PI * 2;
  let normalized = rad % twoPi;
  if (normalized < 0) normalized += twoPi;
  return normalized;
}

/** Height above ground for a given floor, per STEP 7's formula. */
export function computeCameraHeightM(
  floor: number,
  floorHeightM: number,
  eyeHeightM: number
): number {
  return floor * floorHeightM + eyeHeightM;
}
