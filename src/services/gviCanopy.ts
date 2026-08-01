import * as Cesium from "cesium";
import { isLineOfSightClear, YIELD_EVERY, yieldToMain } from "./visibility";
import { DEFAULT_TREE_HEIGHT_M, isValidTreeHeight } from "./treeHeight";
import { VegetationFeature, VegetationPoint } from "./vegetation";
import { generateEllipsePolygon } from "./canopy";

// gviCanopy.ts is the authoritative GVI pipeline (see TREE_HEIGHT_AUDIT.md /
// GVIPanel.tsx for how it supersedes the old pixel-classification score in
// gvi.ts): for the camera's current pose, every tree's real canopy polygon
// (services/canopy.ts) is projected onto the image plane, the portion of
// each canopy blocked by intervening geometry is discounted via the same
// ray-casting used for the per-tree visibility audit (isLineOfSightClear,
// services/visibility.ts), and the GVI score is the ratio of unobstructed
// projected canopy area to total screen area — not a pixel count of a
// rendered screenshot.

export interface TreeGVIResult {
  /** Fraction (0..1) of the sampled canopy points with a clear line of sight to the camera. */
  visibleFraction: number;
  /** This tree's canopy polygon area on screen, in px², before occlusion is applied. */
  totalAreaPx2: number;
  /** totalAreaPx2 * visibleFraction — this tree's contribution to visibleCanopyAreaPx2. */
  visibleAreaPx2: number;
}

export interface CanopyGVIResult {
  visibleCanopyAreaPx2: number;
  totalAreaPx2: number;
  /** visibleCanopyAreaPx2 / totalAreaPx2, clamped to 0..1. */
  gviScore: number;
  perTreeResult: Map<string, TreeGVIResult>;
}

interface ScorableVegetation {
  id: string;
  positions: { latitude: number; longitude: number }[];
  heightM: number;
}

// Occlusion is sampled, not computed per-pixel: the canopy polygon's
// centroid plus its own vertices (capped here) are ray-cast individually,
// and the fraction that reach the camera clear stands in for how much of
// the projected area is actually visible. Cheap enough to run for every
// tree in frame every capture, while still catching a canopy that's only
// partly poking out from behind a building.
const MAX_OCCLUSION_SAMPLES = 7;

/**
 * Ground/canopy-top height (meters) used to place a tree's canopy polygon
 * in world space. Exported so components/GVIProjectionOverlay.tsx can
 * project the same canopy geometry this module scores, for the "GVI
 * Projection" debug overlay.
 */
export function canopyTargetHeightM(tree: VegetationPoint, scene: Cesium.Scene): number {
  const treeHeightM = isValidTreeHeight(tree.treeHeight) ? tree.treeHeight : DEFAULT_TREE_HEIGHT_M;
  if (typeof tree.groundHeight === "number" && Number.isFinite(tree.groundHeight)) {
    return tree.groundHeight + treeHeightM;
  }
  const sampled = scene.globe.getHeight(
    Cesium.Cartographic.fromDegrees(tree.longitude, tree.latitude)
  );
  return (sampled ?? 0) + treeHeightM;
}

function landcoverHeightM(feature: VegetationFeature): number {
  switch (feature.category) {
    case "forest":
    case "wood":
      return 10;
    case "scrub":
      return 2;
    case "grassland":
      return 0.25;
    default:
      return 0;
  }
}

function toScorableVegetation(
  feature: VegetationFeature,
  scene: Cesium.Scene
): ScorableVegetation | null {
  if (feature.kind === "point") {
    if (feature.canopyPolygon && feature.canopyPolygon.length >= 3) {
      return {
        id: feature.id,
        positions: feature.canopyPolygon,
        heightM: canopyTargetHeightM(feature, scene),
      };
    }

    if (feature.category !== "scrub") return null;
    const terrainHeightM = scene.globe.getHeight(
      Cesium.Cartographic.fromDegrees(feature.longitude, feature.latitude)
    );
    return {
      id: feature.id,
      positions: generateEllipsePolygon(
        feature.latitude,
        feature.longitude,
        feature.crownRadius ?? 1.5,
        feature.crownRadius ?? 1.5
      ),
      heightM: (feature.groundHeight ?? terrainHeightM ?? 0) + landcoverHeightM(feature),
    };
  }

  if (
    feature.positions.length < 3 ||
    !["forest", "wood", "scrub", "grassland"].includes(feature.category)
  ) {
    return null;
  }

  return {
    id: feature.id,
    positions: feature.positions,
    heightM: landcoverHeightM(feature),
  };
}

/** Projects a world position to canvas-CSS-pixel window coordinates, or undefined if behind the camera. */
export function projectToWindow(
  scene: Cesium.Scene,
  position: Cesium.Cartesian3
): Cesium.Cartesian2 | undefined {
  const window = Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    position,
    new Cesium.Cartesian2()
  );
  if (!window || !Number.isFinite(window.x) || !Number.isFinite(window.y)) return undefined;
  // A point behind the camera can still project onto the canvas rectangle
  // (worldToWindowCoordinates doesn't itself reject it), which would
  // otherwise inflate area with a mirrored/garbage polygon.
  const toPoint = Cesium.Cartesian3.subtract(
    position,
    scene.camera.positionWC,
    new Cesium.Cartesian3()
  );
  if (Cesium.Cartesian3.dot(toPoint, scene.camera.directionWC) <= 0) return undefined;
  return window;
}

/** Sutherland-Hodgman clip of a convex-ish polygon against the canvas rectangle. */
export function clipToCanvas(
  points: Cesium.Cartesian2[],
  width: number,
  height: number
): Cesium.Cartesian2[] {
  type Edge = (p: Cesium.Cartesian2) => boolean;
  const edges: Array<{ inside: Edge; intersect: (a: Cesium.Cartesian2, b: Cesium.Cartesian2) => Cesium.Cartesian2 }> = [
    {
      inside: (p) => p.x >= 0,
      intersect: (a, b) => new Cesium.Cartesian2(0, a.y + ((0 - a.x) * (b.y - a.y)) / (b.x - a.x)),
    },
    {
      inside: (p) => p.x <= width,
      intersect: (a, b) =>
        new Cesium.Cartesian2(width, a.y + ((width - a.x) * (b.y - a.y)) / (b.x - a.x)),
    },
    {
      inside: (p) => p.y >= 0,
      intersect: (a, b) => new Cesium.Cartesian2(a.x + ((0 - a.y) * (b.x - a.x)) / (b.y - a.y), 0),
    },
    {
      inside: (p) => p.y <= height,
      intersect: (a, b) =>
        new Cesium.Cartesian2(a.x + ((height - a.y) * (b.x - a.x)) / (b.y - a.y), height),
    },
  ];

  let output = points;
  for (const edge of edges) {
    if (output.length === 0) break;
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const previous = input[(i - 1 + input.length) % input.length];
      const currentInside = edge.inside(current);
      const previousInside = edge.inside(previous);
      if (currentInside) {
        if (!previousInside) output.push(edge.intersect(previous, current));
        output.push(current);
      } else if (previousInside) {
        output.push(edge.intersect(previous, current));
      }
    }
  }
  return output;
}

function polygonAreaPx2(points: Cesium.Cartesian2[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * Projects every tree's canopy polygon onto the current camera view, scores
 * how much of it is actually unoccluded, and returns both the aggregate
 * score and a per-tree breakdown (consumed by GVIPanel's stats and
 * VegetationLayer's "Visible/Occluded Canopy" debug coloring).
 */
export async function computeCanopyGVI(
  viewer: Cesium.Viewer,
  features: VegetationFeature[]
): Promise<CanopyGVIResult> {
  const canvas = viewer.scene.canvas as HTMLCanvasElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const totalAreaPx2 = width * height;
  const cameraPosition = Cesium.Cartesian3.clone(viewer.camera.positionWC);

  const perTreeResult = new Map<string, TreeGVIResult>();
  let visibleCanopyAreaPx2 = 0;
  let processed = 0;

  for (const feature of features) {
    const vegetation = toScorableVegetation(feature, viewer.scene);
    if (!vegetation) continue;

    const worldPoints = vegetation.positions.map((point) =>
      Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, vegetation.heightM)
    );
    const centroidWorld = worldPoints.reduce(
      (sum, p) => Cesium.Cartesian3.add(sum, p, sum),
      new Cesium.Cartesian3()
    );
    Cesium.Cartesian3.divideByScalar(centroidWorld, worldPoints.length, centroidWorld);

    const screenPoints = worldPoints
      .map((p) => projectToWindow(viewer.scene, p))
      .filter((p): p is Cesium.Cartesian2 => p !== undefined);

    processed++;
    if (processed % YIELD_EVERY === 0) await yieldToMain();

    if (screenPoints.length < 3) continue;

    const clipped = clipToCanvas(screenPoints, width, height);
    const totalAreaTreePx2 = polygonAreaPx2(clipped);
    if (totalAreaTreePx2 <= 0) continue;

    const samplePositions = [centroidWorld, ...worldPoints].slice(0, MAX_OCCLUSION_SAMPLES);
    let clearCount = 0;
    for (const samplePosition of samplePositions) {
      if (isLineOfSightClear(viewer, cameraPosition, samplePosition, vegetation.id)) clearCount++;
    }
    const visibleFraction = clearCount / samplePositions.length;
    const visibleAreaPx2 = totalAreaTreePx2 * visibleFraction;

    perTreeResult.set(vegetation.id, {
      visibleFraction,
      totalAreaPx2: totalAreaTreePx2,
      visibleAreaPx2,
    });
    visibleCanopyAreaPx2 += visibleAreaPx2;
  }

  const gviScore = totalAreaPx2 > 0 ? Math.min(1, visibleCanopyAreaPx2 / totalAreaPx2) : 0;

  return { visibleCanopyAreaPx2, totalAreaPx2, gviScore, perTreeResult };
}
