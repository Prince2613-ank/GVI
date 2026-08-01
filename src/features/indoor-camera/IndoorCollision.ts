import * as Cesium from "cesium";
import { IndoorCameraConfig } from "./IndoorCameraConfig";

/** Present at runtime (used internally by Cesium's own 3D Tiles picking) but not declared in this version's TS types. */
interface ScenePickFromRay {
  pickFromRay(ray: Cesium.Ray, objectsToExclude?: unknown[]): { position?: Cesium.Cartesian3 } | undefined;
}

interface CachedPick {
  origin: Cesium.Cartesian3;
  direction: Cesium.Cartesian3;
  hitDistance: number | null;
  timestamp: number;
}

let lastPick: CachedPick | null = null;

function reuseCachedPick(
  origin: Cesium.Cartesian3,
  direction: Cesium.Cartesian3,
  now: number
): number | null | undefined {
  if (!lastPick) return undefined;
  if (now - lastPick.timestamp > IndoorCameraConfig.COLLISION_CACHE_MS) return undefined;
  // Only reuse when the ray is (almost) the same one — same spot, same
  // heading — otherwise a stale hit distance could let the camera clip
  // through geometry it never actually raycast against.
  if (Cesium.Cartesian3.distance(origin, lastPick.origin) > 0.05) return undefined;
  if (Cesium.Cartesian3.dot(direction, lastPick.direction) < 0.999) return undefined;
  return lastPick.hitDistance;
}

/**
 * Casts a ray along the requested movement direction and clamps the
 * distance to just short of whatever it hits first (wall, floor, ceiling,
 * any other scene primitive) — the thing that stops the camera from ever
 * passing through geometry, checked fresh every animation frame.
 *
 * `scene.pickFromRay` intersects the building's own GLB model and any other
 * loaded 3D Tiles/primitives; it does not require the ray to originate from
 * screen space, so it works for arbitrary movement directions. It's also a
 * synchronous GPU readback, so calling it on every single frame of
 * continuous movement is cached very briefly — see
 * IndoorCameraConfig.COLLISION_CACHE_MS — reused only while the origin and
 * direction are effectively unchanged, so the cache can never let the
 * camera coast past a wall it hasn't actually raycast against.
 */
export function clampMovementDistance(
  scene: Cesium.Scene,
  origin: Cesium.Cartesian3,
  direction: Cesium.Cartesian3,
  requestedDistance: number,
  padding: number = IndoorCameraConfig.COLLISION_PADDING
): number {
  if (requestedDistance <= 0) return 0;

  const now = performance.now();
  let hitDistance: number | null | undefined = reuseCachedPick(origin, direction, now);

  if (hitDistance === undefined) {
    try {
      const ray = new Cesium.Ray(origin, direction);
      const result = (scene as unknown as ScenePickFromRay).pickFromRay(ray, []);
      hitDistance = result?.position ? Cesium.Cartesian3.distance(origin, result.position) : null;
    } catch {
      // pickFromRay isn't supported in every context (e.g. no WebGL2/depth
      // texture support) — fail OPEN so indoor movement still works, just
      // without the collision guard, rather than freezing navigation.
      hitDistance = null;
    }
    lastPick = { origin: Cesium.Cartesian3.clone(origin), direction: Cesium.Cartesian3.clone(direction), hitDistance, timestamp: now };
  }

  if (hitDistance !== null && hitDistance < requestedDistance) {
    return Math.max(0, hitDistance - padding);
  }

  return requestedDistance;
}
