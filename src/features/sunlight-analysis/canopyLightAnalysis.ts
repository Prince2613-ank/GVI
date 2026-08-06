// Reads the actual rendered pixels of the current (cinematic-lit) Cesium
// view and classifies them into three real, visually-grounded buckets:
// shadow, sunlight filtered through tree canopy, and sunlight hitting bare
// hardscape (concrete/pavement/walls/glass). This is the same technique the
// app's own Green View Index already uses (services/gvi.ts reads the
// canvas and classifies pixels by HSV) — reused here rather than
// reinvented, including the exact vegetation classifier
// (features/window-gvi/vegetation/VegetationDetector.ts) already tuned and
// validated against this app's real scenes (it explicitly excludes things
// like Cesium OSM Buildings' khaki roof color, which a naive green-channel
// check would misclassify).
//
// Only meaningful while the real cinematic sun/shadow effect
// (sunlightEffects.ts) is actually running — with it off the scene is flat
// and unlit, and "shadow vs sunlit" isn't a real distinction in the pixels
// at all.

import * as Cesium from "cesium";
import { rgbToHsv } from "../window-gvi/vegetation/HSV";
import { isVegetationPixel } from "../window-gvi/vegetation/VegetationDetector";

// Below this HSV value, a pixel reads as shadow/unlit rather than
// sunlit-but-dark-colored — matches the same kind of brightness floor the
// vegetation detector already uses for its own minValue threshold.
const SHADOW_VALUE_THRESHOLD = 0.22;

export interface CanopyLightResult {
  totalPixels: number;
  shadowPixels: number;
  canopyFilteredPixels: number;
  harshPixels: number;
  shadowPct: number;
  canopyFilteredPct: number;
  harshPct: number;
}

/** Waits for a real, current frame to actually be on the canvas before reading it back (Cesium's requestRenderMode means the canvas doesn't update every tick on its own). */
function waitForFreshFrame(viewer: Cesium.Viewer): Promise<void> {
  return new Promise((resolve) => {
    viewer.scene.requestRender();
    requestAnimationFrame(() => {
      viewer.scene.render();
      requestAnimationFrame(() => {
        viewer.scene.render();
        resolve();
      });
    });
  });
}

export async function analyzeCanopyLightFilter(viewer: Cesium.Viewer): Promise<CanopyLightResult> {
  await waitForFreshFrame(viewer);

  const sourceCanvas = viewer.scene.canvas as HTMLCanvasElement;
  const offscreen = document.createElement("canvas");
  offscreen.width = sourceCanvas.width;
  offscreen.height = sourceCanvas.height;
  const ctx = offscreen.getContext("2d");
  if (!ctx) throw new Error("Failed to acquire 2D canvas context for canopy light analysis");
  ctx.drawImage(sourceCanvas, 0, 0);

  const { data, width, height } = ctx.getImageData(0, 0, offscreen.width, offscreen.height);
  const totalPixels = width * height;
  let shadowPixels = 0;
  let canopyFilteredPixels = 0;
  let harshPixels = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const { v } = rgbToHsv(r, g, b);

    if (v < SHADOW_VALUE_THRESHOLD) {
      shadowPixels++;
    } else if (isVegetationPixel(r, g, b)) {
      canopyFilteredPixels++;
    } else {
      harshPixels++;
    }
  }

  const pct = (n: number) => Math.round((n / totalPixels) * 1000) / 10;

  return {
    totalPixels,
    shadowPixels,
    canopyFilteredPixels,
    harshPixels,
    shadowPct: pct(shadowPixels),
    canopyFilteredPct: pct(canopyFilteredPixels),
    harshPct: pct(harshPixels),
  };
}
