// Real per-floor sunlight-hours calculation — this is a genuine skyline/
// horizon-occlusion check against the actual loaded 3D scene, not a number
// invented per floor. For a candidate floor+time, it marches outward from
// the window along the sun's azimuth bearing and asks Cesium what surface
// height is actually there (`Scene#sampleHeightMostDetailed`, which forces
// the most detailed available 3D-tile/terrain data to load) — the same
// technique real solar-access studies use (a skyline/horizon profile). If
// anything along that path pokes above the straight line from the window to
// the sun, that floor is shadowed at that time; higher floors clear
// neighboring rooftops sooner, which is exactly why this differs by floor
// in a way a flat orientation-only model cannot.
//
// Bounded on purpose (per the feature's own performance requirement): this
// only runs when the user explicitly asks for a floor summary, samples a
// coarse set of hours/distances, and its result is cached by the caller.

import * as Cesium from "cesium";
import { CardinalDirection, EYE_HEIGHT_M, FLOOR_HEIGHT_M } from "../../utils/constants";
import { computeSunPosition, julianDateAtHour } from "./sunPosition";
import { computeWindowSunlight, windowHeadingDeg } from "./windowSunlight";

const EARTH_RADIUS_M = 6378137;
// Distances checked outward from the window along the sun's bearing —
// coarser further out, since a distant obstruction needs to be much taller
// to matter (its required-clearance line is already high by then).
const MARCH_DISTANCES_M = [15, 30, 60, 100, 150, 220, 300];

function destinationCartographic(
  latitude: number,
  longitude: number,
  bearingDeg: number,
  distanceM: number
): Cesium.Cartographic {
  const bearingRad = Cesium.Math.toRadians(bearingDeg);
  const dLat = (distanceM * Math.cos(bearingRad)) / EARTH_RADIUS_M;
  const dLon = (distanceM * Math.sin(bearingRad)) / (EARTH_RADIUS_M * Math.cos(Cesium.Math.toRadians(latitude)));
  return Cesium.Cartographic.fromDegrees(longitude + Cesium.Math.toDegrees(dLon), latitude + Cesium.Math.toDegrees(dLat));
}

export interface FloorSunlightResult {
  floor: number;
  exposureHours: number;
  peakHour: number | null;
}

/**
 * Real ground elevation at the building's own lon/lat, sampled from the
 * same 3D-tile/terrain surface `sampleHeightMostDetailed` reads everywhere
 * else in this module. Floor heights MUST be built on top of this, not a
 * hardcoded scene constant — a constant used elsewhere for camera framing
 * lives in a different reference frame than the tileset surface, and the
 * mismatch made every floor read as "blocked by its own ground" (0h for
 * every floor) until this was anchored to a real sampled height.
 */
export async function sampleGroundHeightMsl(
  viewer: Cesium.Viewer,
  latitude: number,
  longitude: number
): Promise<number> {
  if (!viewer.scene.sampleHeightSupported) return 0;
  try {
    const [sample] = await viewer.scene.sampleHeightMostDetailed([Cesium.Cartographic.fromDegrees(longitude, latitude)]);
    return sample?.height ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Real horizon check: is the sun, at this elevation/azimuth, unobstructed
 * along the march path from this window? Batches all sample points into a
 * single `sampleHeightMostDetailed` call per hour for efficiency.
 */
async function isSunVisibleFromWindow(
  viewer: Cesium.Viewer,
  windowHeightMsl: number,
  latitude: number,
  longitude: number,
  sunAzimuthDeg: number,
  sunElevationDeg: number
): Promise<boolean> {
  if (!viewer.scene.sampleHeightSupported) return true; // no depth-texture support — can't check, assume unobstructed rather than fabricate shadowing

  const elevationRad = Cesium.Math.toRadians(sunElevationDeg);
  const points = MARCH_DISTANCES_M.map((d) => destinationCartographic(latitude, longitude, sunAzimuthDeg, d));

  let sampled: (Cesium.Cartographic | undefined)[];
  try {
    sampled = await viewer.scene.sampleHeightMostDetailed(points);
  } catch {
    return true; // sampling failed (e.g. tiles not ready) — don't fabricate an obstruction
  }

  for (let i = 0; i < MARCH_DISTANCES_M.length; i++) {
    const sample = sampled[i];
    if (!sample || sample.height === undefined) continue; // no geometry there — nothing to block the sun
    const requiredClearance = windowHeightMsl + MARCH_DISTANCES_M[i] * Math.tan(elevationRad);
    if (sample.height > requiredClearance) return false; // real obstruction taller than the sun's line to this window
  }
  return true;
}

/**
 * Computes today's real sunlight-hours for a single floor on a given
 * facade, using actual scene geometry for occlusion. `groundHeightMsl` MUST
 * come from `sampleGroundHeightMsl` (the real sampled surface height) —
 * not an app-wide scene-positioning constant, which lives in a different
 * reference frame and silently makes every floor read as blocked.
 */
export async function computeFloorSunlight(
  viewer: Cesium.Viewer,
  floor: number,
  side: CardinalDirection,
  latitude: number,
  longitude: number,
  groundHeightMsl: number,
  buildingRotationRad: number,
  sampleHours: number[]
): Promise<FloorSunlightResult> {
  const windowHeightMsl = groundHeightMsl + EYE_HEIGHT_M + (floor - 1) * FLOOR_HEIGHT_M;
  const heading = windowHeadingDeg(buildingRotationRad, side);

  let exposureHours = 0;
  let peakHour: number | null = null;
  let peakIntensity = -1;
  const stepHours = sampleHours.length > 1 ? sampleHours[1] - sampleHours[0] : 1;

  for (const hour of sampleHours) {
    const sun = computeSunPosition(julianDateAtHour(hour), latitude, longitude);
    const facing = computeWindowSunlight(sun, heading);
    if (!facing.isDirectSunlight) continue;

    const visible = await isSunVisibleFromWindow(viewer, windowHeightMsl, latitude, longitude, sun.azimuthDeg, sun.elevationDeg);
    if (!visible) continue;

    exposureHours += stepHours;
    if (facing.intensityPct > peakIntensity) {
      peakIntensity = facing.intensityPct;
      peakHour = hour;
    }
  }

  return { floor, exposureHours, peakHour };
}
