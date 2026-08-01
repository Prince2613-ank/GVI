import * as Cesium from "cesium";
import { CardinalDirection } from "../utils/constants";
import { BuildingTransform, computeWindowCameraPose, setCameraToPoseInstant } from "./camera";
import { captureCanvasThumbnail } from "./gvi";
import { computeCanopyGVI } from "./gviCanopy";
import { VegetationPoint } from "./vegetation";

// gviProfile.ts scans every (floor, direction) combination in the building
// and computes a GVI score for each, then aggregates a single "Floor GVI
// Score" per floor (the average across its 4 facades). This is the data a
// real-estate use of this tool actually needs: a defensible, view-based
// green-exposure ranking across every floor of the building, not just the
// single floor/window currently selected in the interactive view.
//
// The building itself is never moved during a scan — only the camera is
// repositioned (via setCameraToPoseInstant, no flight animation, since an
// animated flyTo per pose would make a 40-floor x 4-direction scan far too
// slow).

export interface FacadeGVIResult {
  direction: CardinalDirection;
  gviScore: number;
  /** Small JPEG thumbnail of the exact view used to compute gviScore, for visual audit. */
  thumbnail: string;
}

export interface FloorGVIProfile {
  floor: number;
  avgGviScore: number;
  byDirection: FacadeGVIResult[];
  rank: number;
}

export interface GVIProfileProgress {
  done: number;
  total: number;
  floor: number;
  direction: CardinalDirection;
}

/** Yields a couple of render frames so newly-visible tiles/geometry can draw before capture. */
function waitForRender(viewer: Cesium.Viewer): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      viewer.scene.render();
      requestAnimationFrame(() => {
        viewer.scene.render();
        resolve();
      });
    });
  });
}

/**
 * Scans every (floor, direction) combination, computing the canopy-area
 * GVI score (services/gviCanopy.ts) at each camera pose and keeping a
 * thumbnail for visual audit. Returns floors sorted by descending average
 * GVI score with a 1-based rank assigned.
 */
export async function computeBuildingGVIProfile(
  viewer: Cesium.Viewer,
  building: BuildingTransform,
  floors: number[],
  directions: CardinalDirection[],
  trees: VegetationPoint[],
  onProgress?: (progress: GVIProfileProgress) => void
): Promise<FloorGVIProfile[]> {
  const total = floors.length * directions.length;
  let done = 0;

  const profiles: FloorGVIProfile[] = [];

  for (const floor of floors) {
    const byDirection: FacadeGVIResult[] = [];

    for (const direction of directions) {
      const pose = computeWindowCameraPose(building, floor, direction);
      setCameraToPoseInstant(viewer, pose);
      await waitForRender(viewer);

      const canvas = viewer.scene.canvas as HTMLCanvasElement;
      const thumbnail = captureCanvasThumbnail(canvas);
      const { gviScore } = await computeCanopyGVI(viewer, trees);
      byDirection.push({ direction, gviScore, thumbnail });

      done++;
      onProgress?.({ done, total, floor, direction });
    }

    const avgGviScore =
      byDirection.reduce((sum, r) => sum + r.gviScore, 0) / byDirection.length;

    profiles.push({ floor, avgGviScore, byDirection, rank: 0 });
  }

  profiles.sort((a, b) => b.avgGviScore - a.avgGviScore);
  profiles.forEach((p, i) => {
    p.rank = i + 1;
  });

  // Re-sort back to floor order for a natural table read, rank already reflects standing.
  profiles.sort((a, b) => a.floor - b.floor);

  return profiles;
}
