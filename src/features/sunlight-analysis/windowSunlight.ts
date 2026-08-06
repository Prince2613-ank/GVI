import * as Cesium from "cesium";
import { CardinalDirection, DIRECTION_HEADING_RAD } from "../../utils/constants";
import { SunPosition } from "./sunPosition";

// A window only receives direct beam sunlight when the sun sits within this
// many degrees of the window's outward-facing normal (a vertical facade
// only "sees" roughly a 180° hemisphere in front of it, but light intensity
// falls off well before grazing incidence looks physically direct).
const DIRECT_SUNLIGHT_THRESHOLD_DEG = 90;

export interface WindowSunlightResult {
  isDirectSunlight: boolean;
  /** 0-100 — cosine falloff by angle-off-normal, scaled by sun elevation. */
  intensityPct: number;
}

/**
 * Outward-facing compass heading (degrees clockwise from north) of a window
 * on the given facade, accounting for the building's own rotation on the
 * ground — mirrors computeOutwardHeadingRad in utils/cameraUtils.ts, kept
 * as plain degrees here since this module has no Cesium camera dependency.
 */
export function windowHeadingDeg(buildingRotationRad: number, side: CardinalDirection): number {
  const facadeHeadingRad = DIRECTION_HEADING_RAD[side];
  const totalRad = buildingRotationRad + facadeHeadingRad;
  const deg = Cesium.Math.toDegrees(totalRad) % 360;
  return deg < 0 ? deg + 360 : deg;
}

function angleDiffDeg(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Direct sunlight requires the sun to be above the horizon AND roughly in
 * front of the window (within DIRECT_SUNLIGHT_THRESHOLD_DEG of its outward
 * normal). Intensity combines how square-on the sun is (cosine of the
 * off-normal angle) with how high it is in the sky (low sun grazes weakly
 * even when pointed straight at the window).
 */
export function computeWindowSunlight(sun: SunPosition, windowHeading: number): WindowSunlightResult {
  if (sun.elevationDeg <= 0) {
    return { isDirectSunlight: false, intensityPct: 0 };
  }

  const offNormalDeg = angleDiffDeg(sun.azimuthDeg, windowHeading);
  if (offNormalDeg >= DIRECT_SUNLIGHT_THRESHOLD_DEG) {
    return { isDirectSunlight: false, intensityPct: 0 };
  }

  const facingFactor = Math.cos(Cesium.Math.toRadians(offNormalDeg));
  const elevationFactor = Math.sin(Cesium.Math.toRadians(Math.min(sun.elevationDeg, 90)));
  const intensityPct = Math.round(Math.max(0, facingFactor) * Math.max(0, elevationFactor) * 100);

  return { isDirectSunlight: intensityPct > 0, intensityPct };
}

export type LightQuality = "None" | "Soft" | "Bright" | "Harsh";

/**
 * A qualitative read on light character by sun elevation — the real reason
 * morning/evening sun "feels" soft and low-contrast (light travels through
 * more atmosphere at a shallow angle, scattering and diffusing it) while
 * midday sun is harsh and high-contrast (a short, direct atmospheric path).
 * Thresholds are the standard golden-hour (<20°) / harsh-noon (>55°)
 * photography convention.
 */
export function lightQualityForElevation(elevationDeg: number): LightQuality {
  if (elevationDeg <= 0) return "None";
  if (elevationDeg < 20) return "Soft";
  if (elevationDeg < 55) return "Bright";
  return "Harsh";
}
