import { ViewshedMask } from "../../../services/visibility";
import {
  DEFAULT_VEGETATION_THRESHOLDS,
  isVegetationPixel,
  VegetationThresholds,
} from "./VegetationDetector";
import { extractTrunks, isWoodyPixel } from "./WoodyDetector";
import {
  BinaryMask,
  medianFilter3x3,
  morphologicalClose,
  morphologicalOpen,
  removeSmallComponents,
} from "./Morphology";

export interface ExternalVegetationMask {
  width: number;
  height: number;
  /** 0/1 per pixel, row-major. */
  data: Uint8Array;
}

export interface SegmentationResult {
  vegetationPixels: number;
  totalPixels: number;
  greyPixels: number;
  gviPercent: number;
  /** Strictly two-color preview: vegetation RGB(0,255,0), everything else RGB(120,120,120). */
  maskDataUrl: string;
  processingTimeMs: number;
  thresholds: VegetationThresholds;
  /** Pixels classified as vegetation by image segmentation alone, before merging manual polygons in. */
  segmentedVegetationPixels: number;
  /** Pixels added by the manual vegetation mask that segmentation alone didn't already classify as vegetation. */
  manualVegetationPixels: number;
  /** Pixels contributed by trunks/branches that the green-foliage pass alone would have missed. */
  trunkPixels: number;
}

const VEGETATION_COLOR: readonly [number, number, number] = [0, 255, 0];
const NEUTRAL_COLOR: readonly [number, number, number] = [120, 120, 120];
/** Pixels excluded via an optional viewshed mask keep the same dark-navy convention as the legacy audit view. */
const EXCLUDED_COLOR: readonly [number, number, number] = [0, 0, 40];

function isWithinViewshed(
  mask: ViewshedMask | undefined,
  px: number,
  py: number,
  width: number,
  height: number
): boolean {
  if (!mask) return true;
  const col = Math.min(mask.cols - 1, Math.floor((px / width) * mask.cols));
  const row = Math.min(mask.rows - 1, Math.floor((py / height) * mask.rows));
  return mask.cells[row * mask.cols + col];
}

/**
 * Full vegetation segmentation pipeline: multi-criteria per-pixel
 * classification (HSV hue/sat/value range AND Excess Green AND green
 * ratio — never a single RGB/hue threshold on its own), then median
 * filter -> morphological opening -> morphological closing -> small-blob
 * removal to strip the residual green noise a naive threshold leaves in
 * roads/roofs/shadows/glass.
 *
 * If `manualVegetationMask` is given (see features/manual-vegetation), it's
 * unioned into the classified mask AFTER the cleanup pipeline — manual
 * polygons are user-asserted ground truth, so they skip the noise-removal
 * pass that's only there to correct the automated classifier's mistakes.
 */
export function segmentVegetation(
  imageData: ImageData,
  options: {
    thresholds?: VegetationThresholds;
    viewshedMask?: ViewshedMask;
    minComponentSizePx?: number;
    manualVegetationMask?: ExternalVegetationMask;
    /** Count trunks/branches as vegetation (default true) — see WoodyDetector. */
    includeTrunks?: boolean;
  } = {}
): SegmentationResult {
  const {
    thresholds = DEFAULT_VEGETATION_THRESHOLDS,
    viewshedMask,
    minComponentSizePx = 20,
    manualVegetationMask,
    includeTrunks = true,
  } = options;

  const start = performance.now();
  const { width, height, data } = imageData;
  const pixelCount = width * height;

  const rawMask = new Uint8Array(pixelCount);
  const withinViewshed = new Uint8Array(pixelCount);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = py * width + px;
      const inView = isWithinViewshed(viewshedMask, px, py, width, height);
      withinViewshed[idx] = inView ? 1 : 0;
      if (!inView) continue;

      const o = idx * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      rawMask[idx] = isVegetationPixel(r, g, b, thresholds) ? 1 : 0;
    }
  }

  let mask: BinaryMask = { data: rawMask, width, height };
  mask = medianFilter3x3(mask);
  mask = morphologicalOpen(mask);
  mask = morphologicalClose(mask);
  mask = removeSmallComponents(mask, minComponentSizePx);

  // Trunks and branches are vegetation too, but they're brown, so the
  // foliage pass above rejects every one of them. They're added here, after
  // the cleanup pass has established where the foliage actually is — see
  // WoodyDetector, which only accepts woody regions attached to that
  // foliage and shaped like a trunk, so brown roofs/roads/soil can't slip
  // in on colour alone.
  let trunkPixels = 0;
  if (includeTrunks) {
    const woodyCandidates = new Uint8Array(pixelCount);
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const idx = py * width + px;
        // Never reconsider a pixel foliage already claimed, and never look
        // outside the viewshed.
        if (!withinViewshed[idx] || mask.data[idx] === 1) continue;
        const o = idx * 4;
        woodyCandidates[idx] = isWoodyPixel(data[o], data[o + 1], data[o + 2]) ? 1 : 0;
      }
    }
    const trunks = extractTrunks({ data: woodyCandidates, width, height }, mask);
    for (let i = 0; i < pixelCount; i++) {
      if (trunks.data[i] === 1 && mask.data[i] !== 1) {
        mask.data[i] = 1;
        trunkPixels++;
      }
    }
  }

  let segmentedVegetationPixels = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (withinViewshed[i] && mask.data[i] === 1) segmentedVegetationPixels++;
  }

  // Final Vegetation Mask = Segmented Vegetation UNION Manual Vegetation Mask.
  let manualVegetationPixels = 0;
  const useManualMask =
    manualVegetationMask &&
    manualVegetationMask.width === width &&
    manualVegetationMask.height === height;
  if (useManualMask) {
    for (let i = 0; i < pixelCount; i++) {
      if (!withinViewshed[i]) continue;
      if (manualVegetationMask!.data[i] === 1 && mask.data[i] !== 1) {
        mask.data[i] = 1;
        manualVegetationPixels++;
      }
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to acquire 2D canvas context for vegetation segmentation preview");
  }
  const outImageData = ctx.createImageData(width, height);

  let vegetationPixels = 0;
  let totalPixels = 0;

  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    if (!withinViewshed[i]) {
      const [r, g, b] = EXCLUDED_COLOR;
      outImageData.data[o] = r;
      outImageData.data[o + 1] = g;
      outImageData.data[o + 2] = b;
      outImageData.data[o + 3] = 255;
      continue;
    }

    totalPixels++;
    const isVeg = mask.data[i] === 1;
    if (isVeg) vegetationPixels++;
    const [r, g, b] = isVeg ? VEGETATION_COLOR : NEUTRAL_COLOR;
    outImageData.data[o] = r;
    outImageData.data[o + 1] = g;
    outImageData.data[o + 2] = b;
    outImageData.data[o + 3] = 255;
  }

  ctx.putImageData(outImageData, 0, 0);

  return {
    vegetationPixels,
    totalPixels,
    greyPixels: totalPixels - vegetationPixels,
    gviPercent: totalPixels > 0 ? (vegetationPixels / totalPixels) * 100 : 0,
    maskDataUrl: canvas.toDataURL("image/png"),
    processingTimeMs: performance.now() - start,
    thresholds,
    segmentedVegetationPixels,
    manualVegetationPixels,
    trunkPixels,
  };
}
