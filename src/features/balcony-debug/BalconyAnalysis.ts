import * as Cesium from "cesium";
import { computeCanopyGVI } from "../../services/gviCanopy";
import { computeOutwardHeadingRad } from "../../utils/cameraUtils";
import { VegetationFeature } from "../../services/vegetation";
import { BalconyViewpointFeature, makeBalconyId } from "./BalconyTypes";

export interface BalconyGviResult {
  id: string;
  gviScore: number;
  visibleCanopyAreaPx2: number;
  totalAreaPx2: number;
}

/** Sorted floor -> side -> balcony so an auto-analysis run walks the building in a predictable order. */
export function sortBalconyFeatures(
  features: BalconyViewpointFeature[]
): BalconyViewpointFeature[] {
  return [...features].sort((a, b) => {
    const idA = makeBalconyId(a.properties.floor, a.properties.side, a.properties.balcony);
    const idB = makeBalconyId(b.properties.floor, b.properties.side, b.properties.balcony);
    return idA.localeCompare(idB);
  });
}

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
 * Points the camera at the exact captured indoor eye position and looks
 * straight out through the facade on that side, so computeCanopyGVI's
 * screen-space projection scores what a person standing at that balcony
 * would actually see outside — not an arbitrary orbit angle.
 */
export function pointCameraAtBalcony(
  viewer: Cesium.Viewer,
  feature: BalconyViewpointFeature,
  buildingRotationRad: number
): void {
  const [longitude, latitude, height] = feature.geometry.coordinates;
  const heading = computeOutwardHeadingRad(buildingRotationRad, feature.properties.side);
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
    orientation: { heading, pitch: 0, roll: 0 },
  });
}

export async function analyzeBalconyViewpoint(
  viewer: Cesium.Viewer,
  feature: BalconyViewpointFeature,
  buildingRotationRad: number,
  vegetationFeatures: VegetationFeature[]
): Promise<BalconyGviResult> {
  pointCameraAtBalcony(viewer, feature, buildingRotationRad);
  await waitForRender(viewer);
  const result = await computeCanopyGVI(viewer, vegetationFeatures);
  return {
    id: feature.properties.id,
    gviScore: result.gviScore,
    visibleCanopyAreaPx2: result.visibleCanopyAreaPx2,
    totalAreaPx2: result.totalAreaPx2,
  };
}

/**
 * Walks every captured balcony viewpoint (indoor eye position) in order,
 * looking out through the facade to score the Green View Index visible from
 * that exact spot. Runs sequentially — each step needs the previous frame's
 * camera move to actually render before ray-casting/projection are valid.
 */
export async function analyzeAllBalconies(
  viewer: Cesium.Viewer,
  features: BalconyViewpointFeature[],
  buildingRotationRad: number,
  vegetationFeatures: VegetationFeature[],
  onProgress: (done: number, total: number, latest: BalconyGviResult) => void,
  shouldCancel: () => boolean
): Promise<Map<string, BalconyGviResult>> {
  const ordered = sortBalconyFeatures(features);
  const results = new Map<string, BalconyGviResult>();
  for (let i = 0; i < ordered.length; i++) {
    if (shouldCancel()) break;
    const result = await analyzeBalconyViewpoint(
      viewer,
      ordered[i],
      buildingRotationRad,
      vegetationFeatures
    );
    results.set(result.id, result);
    onProgress(i + 1, ordered.length, result);
  }
  return results;
}
