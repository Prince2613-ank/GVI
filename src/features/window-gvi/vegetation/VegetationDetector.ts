import { rgbToHsv } from "./HSV";
import { excessGreen, greenRatio } from "./Metrics";

export interface VegetationThresholds {
  minHueDeg: number;
  maxHueDeg: number;
  minSaturation: number;
  minValue: number;
  minExcessGreen: number;
  minGreenRatio: number;
  /** G must exceed R by at least this many 0-255 levels. */
  minGreenMinusRed: number;
  /** G must exceed B by at least this many 0-255 levels. */
  minGreenMinusBlue: number;
}

/**
 * A single RGB threshold (e.g. G > R) misclassifies huge amounts of a real
 * urban scene as vegetation — grey roofs, shadowed concrete, and glass all
 * satisfy that on their own. Real vegetation reliably satisfies ALL of
 * these simultaneously, so requiring every condition (not just one) is what
 * actually excludes roads/roofs/walls/shadows/cars/water/sky.
 *
 * The green-dominance checks (minGreenMinusRed/Blue) exist because
 * Cesium OSM Buildings' default khaki/olive roof color (observed ~RGB
 * 172,169,127) sits right at the edge of the hue/ExG/ratio thresholds
 * alone (hue ~56°, ExG ~39, ratio ~0.36) — small per-pixel lighting
 * variance was enough to tip individual roof pixels across the hue cutoff,
 * showing up as green speckle noise on rooftops. That same khaki color has
 * G <= R (no green dominance at all), which real vegetation never does —
 * requiring it closes the gap regardless of where the hue boundary sits.
 *
 * minHueDeg was widened from 75 to 45 (and the ExG/ratio/green-dominance
 * floors lowered to match) to bring dry/brown/autumn foliage into range —
 * that hue band (~45-75°, still G > R > B) still keeps enough margin above
 * the khaki roof's hue (~56°) plus its G <= R failure to stay excluded.
 */
export const DEFAULT_VEGETATION_THRESHOLDS: VegetationThresholds = {
  minHueDeg: 45,
  maxHueDeg: 170,
  minSaturation: 0.15,
  minValue: 0.1,
  minExcessGreen: 20,
  minGreenRatio: 0.3,
  minGreenMinusRed: 6,
  minGreenMinusBlue: 8,
};

export function isVegetationPixel(
  r: number,
  g: number,
  b: number,
  thresholds: VegetationThresholds = DEFAULT_VEGETATION_THRESHOLDS
): boolean {
  const { h, s, v } = rgbToHsv(r, g, b);
  const exg = excessGreen(r, g, b);
  const ratio = greenRatio(r, g, b);

  return (
    h >= thresholds.minHueDeg &&
    h <= thresholds.maxHueDeg &&
    s >= thresholds.minSaturation &&
    v >= thresholds.minValue &&
    exg >= thresholds.minExcessGreen &&
    ratio >= thresholds.minGreenRatio &&
    g - r >= thresholds.minGreenMinusRed &&
    g - b >= thresholds.minGreenMinusBlue
  );
}
