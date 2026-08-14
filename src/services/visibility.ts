import * as Cesium from "cesium";
import { offsetLatLon } from "../utils/geo";
import { LINE_OF_SIGHT_TOLERANCE_M } from "../utils/constants";

// Cesium's shipped .d.ts omits Scene#pickFromRay even though it exists at
// runtime (verified directly in node_modules/cesium's built source) — this
// narrow augmentation fills just that gap instead of casting to `any`.
interface PickFromRayResult {
  object?: unknown;
  position?: Cesium.Cartesian3;
}
interface SceneWithRayPicking {
  pickFromRay(
    ray: Cesium.Ray,
    objectsToExclude?: unknown[],
    width?: number
  ): PickFromRayResult | undefined;
}
// Exported so skyViewFactor.ts's hemisphere ray sweep can reuse the exact
// same picking call instead of re-deriving the runtime-only-API workaround.
export function pickFromRay(scene: Cesium.Scene, ray: Cesium.Ray): PickFromRayResult | undefined {
  return (scene as unknown as SceneWithRayPicking).pickFromRay(ray, []);
}

function pickedObjectMatchesTarget(object: unknown, targetId: string): boolean {
  if (!object || typeof object !== "object") return false;
  const candidate = object as {
    id?: unknown;
    primitive?: { id?: unknown };
  };
  const normalizeId = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const nested = (value as { id?: unknown }).id;
      if (typeof nested === "string") return nested;
    }
    return undefined;
  };
  const ids = [normalizeId(candidate.id), normalizeId(candidate.primitive?.id)].filter(
    (id): id is string => Boolean(id)
  );
  return ids.some(
    (id) =>
      id === targetId ||
      id === `veg-${targetId}` ||
      id === `crown-${targetId}` ||
      id === `trunk-${targetId}`
  );
}

// Each pickFromRay call does a real (if small) off-screen render, so a
// tight loop of hundreds of them with no await in between blocks the main
// thread for the whole loop — the browser tab reports as "not responding"
// and the window stops taking input entirely. Yielding back to the event
// loop every YIELD_EVERY iterations keeps the tab responsive; the analysis
// still takes real wall-clock time, but the UI never freezes while it runs.
export const YIELD_EVERY = 8;
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// visibility.ts answers "what can actually be seen from this exact eye
// position" — not just "what's within N meters." A tree behind another
// building, or on the far side of this building, is not visible from a
// given floor/facade even though it's inside the search radius; this uses
// Cesium's ray picking to test the straight-line path from the eye to each
// candidate target against everything actually in the scene: terrain, OSM
// buildings, and the placed building itself.

export interface VisibilityTarget {
  id: string;
  latitude: number;
  longitude: number;
  /** Height of the point being checked, in meters above the ellipsoid. */
  heightM: number;
}

export interface VisibilityResult {
  visibleIds: Set<string>;
  obstructedIds: Set<string>;
}

/** True when a world-space point is inside the camera's real 3D frustum. */
export function isPointInCameraView(
  camera: Cesium.Camera,
  position: Cesium.Cartesian3,
  radiusM = 0
): boolean {
  const cullingVolume = camera.frustum.computeCullingVolume(
    camera.positionWC,
    camera.directionWC,
    camera.upWC
  );
  return (
    cullingVolume.computeVisibility(new Cesium.BoundingSphere(position, radiusM)) !==
    Cesium.Intersect.OUTSIDE
  );
}

/**
 * True when a straight-line sightline from `from` to `to` reaches `to`
 * without first hitting something else in the scene (a building, terrain,
 * etc). Reaching the target's own rendered geometry (matched via
 * `targetId`) counts as clear, not an obstruction. Exported so
 * gviCanopy.ts's per-canopy-sample-point occlusion test can reuse the same
 * ray-cast logic as the per-tree visibility audit below, instead of
 * duplicating it.
 */
export function isLineOfSightClear(
  viewer: Cesium.Viewer,
  from: Cesium.Cartesian3,
  to: Cesium.Cartesian3,
  targetId: string
): boolean {
  const direction = Cesium.Cartesian3.subtract(to, from, new Cesium.Cartesian3());
  const distance = Cesium.Cartesian3.magnitude(direction);
  if (distance === 0) return true;
  Cesium.Cartesian3.normalize(direction, direction);

  // Nudge the ray's origin slightly along its direction so it doesn't
  // immediately self-intersect the facade the eye point sits right next to.
  const origin = Cesium.Cartesian3.add(
    from,
    Cesium.Cartesian3.multiplyByScalar(direction, 0.25, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );
  const ray = new Cesium.Ray(origin, direction);

  const hit = pickFromRay(viewer.scene, ray);
  if (!hit?.position) return true;
  // Reaching the target tree's own clamped ellipse or LiDAR crown is a
  // successful sightline, not an obstruction in front of that tree.
  if (pickedObjectMatchesTarget(hit.object, targetId)) return true;

  const hitDistance = Cesium.Cartesian3.distance(origin, hit.position);
  return hitDistance >= distance - LINE_OF_SIGHT_TOLERANCE_M;
}

/**
 * Ray-tests line of sight from `eyePosition` to each target, yielding to
 * the browser periodically so a long target list can't freeze the tab.
 * Callers should pre-filter `targets` to the camera frustum and analysis
 * radius, as App.tsx does, so off-screen trees do not consume ray casts.
 */
export async function computeVisibility(
  viewer: Cesium.Viewer,
  eyePosition: Cesium.Cartesian3,
  targets: VisibilityTarget[]
): Promise<VisibilityResult> {
  const visibleIds = new Set<string>();
  const obstructedIds = new Set<string>();

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const targetPosition = Cesium.Cartesian3.fromDegrees(
      target.longitude,
      target.latitude,
      target.heightM
    );
    if (isLineOfSightClear(viewer, eyePosition, targetPosition, target.id)) {
      visibleIds.add(target.id);
    } else {
      obstructedIds.add(target.id);
    }

    if (i % YIELD_EVERY === YIELD_EVERY - 1) {
      await yieldToMain();
    }
  }

  return { visibleIds, obstructedIds };
}

/**
 * Casts a ring of rays outward from the eye position toward ground level,
 * to build a real "what this eye can see" viewshed polygon instead of a
 * flat search-radius circle. Where a building/terrain blocks the line of
 * sight before reaching maxRadiusM, the boundary is pulled in to the
 * obstruction's position for that bearing. Yields periodically — see
 * computeVisibility's comment above.
 */
export async function computeViewshedPolygon(
  viewer: Cesium.Viewer,
  eyeLatitude: number,
  eyeLongitude: number,
  eyeHeightM: number,
  maxRadiusM: number,
  numRays: number
): Promise<{ latitude: number; longitude: number }[]> {
  const eyePosition = Cesium.Cartesian3.fromDegrees(eyeLongitude, eyeLatitude, eyeHeightM);
  const polygon: { latitude: number; longitude: number }[] = [];

  for (let i = 0; i < numRays; i++) {
    const bearingRad = ((2 * Math.PI) / numRays) * i;
    const eastM = Math.sin(bearingRad) * maxRadiusM;
    const northM = Math.cos(bearingRad) * maxRadiusM;
    const farPoint = offsetLatLon(eyeLatitude, eyeLongitude, eastM, northM);

    const targetPosition = Cesium.Cartesian3.fromDegrees(
      farPoint.longitude,
      farPoint.latitude,
      0
    );
    const direction = Cesium.Cartesian3.subtract(
      targetPosition,
      eyePosition,
      new Cesium.Cartesian3()
    );
    Cesium.Cartesian3.normalize(direction, direction);
    const origin = Cesium.Cartesian3.add(
      eyePosition,
      Cesium.Cartesian3.multiplyByScalar(direction, 0.25, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const ray = new Cesium.Ray(origin, direction);
    const hit = pickFromRay(viewer.scene, ray);

    if (hit?.position) {
      const hitCarto = Cesium.Cartographic.fromCartesian(hit.position);
      polygon.push({
        latitude: Cesium.Math.toDegrees(hitCarto.latitude),
        longitude: Cesium.Math.toDegrees(hitCarto.longitude),
      });
    } else {
      polygon.push(farPoint);
    }

    if (i % YIELD_EVERY === YIELD_EVERY - 1) {
      await yieldToMain();
    }
  }

  return polygon;
}

export interface ViewshedMask {
  /** Row-major grid of "is this cell within the viewshed radius" flags. */
  cells: boolean[];
  cols: number;
  rows: number;
}

/**
 * Determines, for a coarse grid over the current camera view, which cells
 * are actually within the viewshed radius (vs. background/sky beyond it) —
 * using the SAME screen the captured image comes from (Camera#getPickRay),
 * so this mask lines up pixel-for-pixel with what computeGVIFromDataUrl
 * receives. GVI should only be computed from the area actually being
 * analyzed (the viewshed), not the entire rectangular photo, which can
 * include far background well past the search radius.
 *
 * Each cell costs one real ray-pick, so the grid is intentionally coarse
 * (see gridCols/gridRows callers pass), and yields to the browser
 * periodically so this can't freeze the tab.
 */
export async function computeViewshedMask(
  viewer: Cesium.Viewer,
  canvasWidth: number,
  canvasHeight: number,
  maxRadiusM: number,
  gridCols: number,
  gridRows: number
): Promise<ViewshedMask> {
  const cameraPosition = viewer.camera.positionWC;
  const cells: boolean[] = new Array(gridCols * gridRows).fill(false);
  let i = 0;

  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      const x = ((col + 0.5) / gridCols) * canvasWidth;
      const y = ((row + 0.5) / gridRows) * canvasHeight;
      const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));

      if (ray) {
        const hit = pickFromRay(viewer.scene, ray);
        if (hit?.position) {
          const distance = Cesium.Cartesian3.distance(cameraPosition, hit.position);
          cells[row * gridCols + col] = distance <= maxRadiusM;
        }
        // No hit (sky) leaves the cell false — outside the viewshed.
      }

      i++;
      if (i % YIELD_EVERY === 0) {
        await yieldToMain();
      }
    }
  }

  return { cells, cols: gridCols, rows: gridRows };
}
