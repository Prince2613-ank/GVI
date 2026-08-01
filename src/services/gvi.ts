import { ViewshedMask } from "./visibility";
import {
  ExternalVegetationMask,
  segmentVegetation,
} from "../features/window-gvi/vegetation/Segmentation";
import { VegetationThresholds } from "../features/window-gvi/vegetation/VegetationDetector";

// gvi.ts is responsible only for image processing: turning a captured
// canvas frame into a Green View Index score.
//
// The default "visual-hsv" mode delegates to
// features/window-gvi/vegetation/Segmentation.ts — a real multi-criteria
// vegetation detector (HSV range AND Excess Green AND green ratio, plus a
// median-filter/morphological-opening-closing/small-blob-removal cleanup
// pass) instead of a single RGB/hue threshold, which was misclassifying
// roads, roofs, walls and shadows as vegetation. See that module (and its
// sibling HSV.ts/Metrics.ts/Morphology.ts/VegetationDetector.ts) to swap in
// a learned segmentation model (DeepLabV3/SegFormer/etc.) later without
// touching this file's public API.

export interface GVIResult {
  greenPixelCount: number;
  totalPixelCount: number;
  gviScore: number; // 0..1
  /**
   * Same frame color-coded three ways: classified vegetation in bright
   * green, everything else within the viewshed dimmed to grayscale, and
   * anything outside the viewshed (background past the search radius, or
   * sky) tinted dark navy to show it was excluded from the score entirely.
   * Without a viewshedMask, everything counts as "within the viewshed" and
   * there's no navy region. Omitted when generateMask is false (see
   * computeGVIFromDataUrl) — the full-building scan skips it since it's
   * only useful for the single interactive capture, not 160 discarded ones.
   */
  maskDataUrl?: string;
  /** Debug/audit fields — only populated by the "visual-hsv" segmentation pipeline. */
  greyPixelCount?: number;
  processingTimeMs?: number;
  thresholdsUsed?: VegetationThresholds;
  /** Pixels classified as vegetation by image segmentation alone (before manual polygons were merged in). */
  segmentedVegetationPixelCount?: number;
  /** Pixels added on top of segmentation by the manual vegetation mask. */
  manualVegetationPixelCount?: number;
}

/** Green geometry on an otherwise black semantic ID render. */
function isSemanticVegetationPixel(r: number, g: number, b: number): boolean {
  return g >= 4 && g > r * 1.18 && g > b * 1.18;
}

/** Looks up whether a full-res pixel falls in an "in viewshed" mask cell. */
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
 * Computes GVI from a data URL (e.g. from canvas.toDataURL()).
 *
 * "visual-hsv" (the default, used for real captured scene photos) runs the
 * full multi-criteria vegetation segmentation pipeline — see
 * features/window-gvi/vegetation/Segmentation.ts.
 *
 * "semantic-mask" is unchanged: a flat black-backdrop render where only
 * mapped vegetation entities are given their own green material (see
 * services/semanticMask.ts) — a much simpler green-channel-dominance check
 * is correct there since nothing else in that synthetic frame is green.
 *
 * If `viewshedMask` is provided (see services/visibility.ts), pixels
 * outside the viewshed (background past the search radius, or sky) are
 * excluded from BOTH the green count and the total — the score reflects
 * only the area actually being analyzed, not the whole rectangular photo.
 *
 * Set generateMask: false to skip building the audit-highlight image —
 * used by the full-building scan (services/gviProfile.ts), which runs this
 * 160 times and never displays the mask for most of them.
 */
export async function computeGVIFromDataUrl(
  dataUrl: string,
  options: {
    generateMask?: boolean;
    viewshedMask?: ViewshedMask;
    classificationMode?: "visual-hsv" | "semantic-mask";
    /** Manual vegetation polygons projected into this exact captured frame — see features/manual-vegetation. */
    manualVegetationMask?: ExternalVegetationMask;
  } = {}
): Promise<GVIResult> {
  const {
    generateMask = true,
    viewshedMask,
    classificationMode = "visual-hsv",
    manualVegetationMask,
  } = options;
  const image = await loadImage(dataUrl);

  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to acquire 2D canvas context for GVI processing");
  }

  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { width, height } = canvas;

  if (classificationMode === "visual-hsv") {
    const segmentation = segmentVegetation(imageData, { viewshedMask, manualVegetationMask });
    return {
      greenPixelCount: segmentation.vegetationPixels,
      totalPixelCount: segmentation.totalPixels,
      gviScore: segmentation.gviPercent / 100,
      maskDataUrl: generateMask ? segmentation.maskDataUrl : undefined,
      greyPixelCount: segmentation.greyPixels,
      processingTimeMs: segmentation.processingTimeMs,
      thresholdsUsed: segmentation.thresholds,
      segmentedVegetationPixelCount: segmentation.segmentedVegetationPixels,
      manualVegetationPixelCount: segmentation.manualVegetationPixels,
    };
  }

  // "semantic-mask" path: unchanged flat black-backdrop classification.
  const { data } = imageData;
  let greenPixelCount = 0;
  let totalPixelCount = 0;

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const i = (py * width + px) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const inViewshed = isWithinViewshed(viewshedMask, px, py, width, height);

      if (!inViewshed) {
        if (generateMask) {
          // Tint excluded (out-of-viewshed) pixels dark navy.
          data[i] = r * 0.15;
          data[i + 1] = g * 0.15;
          data[i + 2] = 40 + b * 0.15;
        }
        continue;
      }

      totalPixelCount++;
      const isGreen = isSemanticVegetationPixel(r, g, b);
      if (isGreen) greenPixelCount++;

      if (generateMask) {
        if (isGreen) {
          // Highlight classified-vegetation pixels in solid green.
          data[i] = 40;
          data[i + 1] = 220;
          data[i + 2] = 60;
        } else {
          // Darken everything else to grayscale so the highlight stands out.
          const gray = 0.299 * r + 0.587 * g + 0.114 * b;
          const dimmed = gray * 0.4;
          data[i] = dimmed;
          data[i + 1] = dimmed;
          data[i + 2] = dimmed;
        }
      }
    }
  }

  let maskDataUrl: string | undefined;
  if (generateMask) {
    ctx.putImageData(imageData, 0, 0);
    maskDataUrl = canvas.toDataURL("image/png");
  }

  return {
    greenPixelCount,
    totalPixelCount,
    gviScore: totalPixelCount > 0 ? greenPixelCount / totalPixelCount : 0,
    maskDataUrl,
  };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load captured frame image"));
    img.src = src;
  });
}

/** Captures the current Cesium canvas as a base64 PNG data URL. */
export function captureCanvas(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png");
}

/**
 * Captures a small, scaled-down JPEG thumbnail of the current canvas. Used
 * by the full-building GVI scan (services/gviProfile.ts), which needs to
 * keep a preview image per floor/direction so the computed score can be
 * visually audited — but 160 full-resolution PNGs would be far too much
 * memory to hold at once.
 */
export function captureCanvasThumbnail(
  canvas: HTMLCanvasElement,
  maxWidth = 200
): string {
  const scale = Math.min(1, maxWidth / canvas.width);
  const width = Math.round(canvas.width * scale);
  const height = Math.round(canvas.height * scale);

  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = width;
  thumbCanvas.height = height;
  const ctx = thumbCanvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to acquire 2D canvas context for thumbnail capture");
  }
  ctx.drawImage(canvas, 0, 0, width, height);
  return thumbCanvas.toDataURL("image/jpeg", 0.7);
}
