// Sky View Factor (SVF) — how much of what this window/viewpoint actually
// shows is open sky, versus a neighbouring building, the subject building's
// own facade or window frame, or tree canopy. Unlike the Sunlight panel's
// other readings, this is sun-independent: it answers "does this spot feel
// enclosed by a street canyon" regardless of time of day or season.
//
// Textbook SVF (Steyn 1980 / Oke 1981 — the formula behind tools like
// RayMan/SOLWEIG) integrates the FULL overhead hemisphere at a point,
// direction-agnostic. An earlier version of this module did exactly that —
// sweeping a fixed geographic azimuth/elevation grid from the eye position —
// but that only gives a meaningful reading when the eye is genuinely
// outdoors and clear of nearby geometry. This feature's eye position is
// whatever the free-fly "current view" camera happens to be, which is very
// often INSIDE a room looking out through a window: from there, most of the
// true hemisphere is legitimately blocked by the room's own walls/ceiling/
// floor, and a coarse geographic grid can miss the one narrow opening
// (between window mullions) where real sky is visible — reporting 0% even
// while sky fills a third of the rendered frame.
//
// So instead this samples the camera's actual current FRUSTUM — the same
// technique visibility.ts's computeViewshedMask already uses
// (Camera#getPickRay over a grid of screen points) — which guarantees every
// sample is something the user can actually see right now. This trades
// strict hemisphere-agnosticism for reliability: it answers "of what I'm
// looking at, how much is open sky" rather than "of the entire sky dome
// above this exact point, how much is open" — the more useful and honest
// question when the eye position itself isn't a guaranteed clear exterior
// point the way GVI's own window capture pose is.

import * as Cesium from "cesium";
import { pickFromRay, YIELD_EVERY, yieldToMain } from "../../services/visibility";

const GRID_COLS = 18;
const GRID_ROWS = 12;

export interface SkyViewFactorResult {
  /** 0 (no open sky in view) to 1 (entirely open sky). */
  svf: number;
  svfPct: number;
  /** Row-major grid, true = that sampled screen cell reached open sky. */
  grid: boolean[];
  cols: number;
  rows: number;
}

/**
 * Casts a grid of rays through the current camera view and measures what
 * fraction reach open sky (no scene hit) versus something in the scene —
 * a building, the subject tower itself, its own window frame, or tree
 * canopy. Yields periodically (see visibility.ts) since this is
 * GRID_COLS * GRID_ROWS real ray-picks.
 */
export async function computeSkyViewFactor(viewer: Cesium.Viewer): Promise<SkyViewFactorResult> {
  const canvas = viewer.scene.canvas as HTMLCanvasElement;
  const grid: boolean[] = new Array(GRID_COLS * GRID_ROWS).fill(false);
  let openCount = 0;
  let i = 0;

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const x = ((col + 0.5) / GRID_COLS) * canvas.width;
      const y = ((row + 0.5) / GRID_ROWS) * canvas.height;
      const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));

      // No ray at this screen point (shouldn't normally happen for an
      // on-canvas point) is treated as blocked, not open — an actual
      // reading requires a real cast, not an absence of one.
      let isOpen = false;
      if (ray) {
        const hit = pickFromRay(viewer.scene, ray);
        isOpen = !hit?.position;
      }

      grid[row * GRID_COLS + col] = isOpen;
      if (isOpen) openCount++;

      i++;
      if (i % YIELD_EVERY === 0) {
        await yieldToMain();
      }
    }
  }

  const svf = openCount / (GRID_COLS * GRID_ROWS);

  return {
    svf,
    svfPct: Math.round(svf * 1000) / 10,
    grid,
    cols: GRID_COLS,
    rows: GRID_ROWS,
  };
}

export function skyOpennessLabel(svf: number): string {
  if (svf >= 0.7) return "Open sky";
  if (svf >= 0.4) return "Partially enclosed";
  return "Street canyon";
}
