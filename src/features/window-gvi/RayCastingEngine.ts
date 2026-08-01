import * as Cesium from "cesium";

// Casts real rays into the live Cesium scene (terrain, 3D tiles, entities —
// not a screenshot) and returns what each one hit first.
//
// IMPORTANT PERFORMANCE NOTE (read before raising rayCount): Cesium's
// scene.pickFromRay does a real off-screen render per call — it is not a
// cheap CPU-only intersection test. The existing visibility analysis in
// this app (services/visibility.ts) already established the pattern this
// engine reuses: yield to the browser every YIELD_EVERY rays so a large
// batch can't freeze the tab, and treat "thousands of rays" as something
// that takes real wall-clock seconds, not an instant call. The spec asks
// for 2000-5000 rays per direction; DEFAULT_RAY_CAST_CONFIG in types.ts
// deliberately defaults much lower (96) so "Analyze Building" over many
// windows stays usable, with rayCount exposed as a user-configurable dial
// in the UI for anyone who wants to trade wait time for resolution on a
// single window.

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

export const YIELD_EVERY = 8;
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface RayResult {
  origin: Cesium.Cartesian3;
  direction: Cesium.Cartesian3;
  hitPosition: Cesium.Cartesian3 | null;
  hitObject: unknown;
  distanceM: number | null;
}

/**
 * Generates `rayCount` ray directions spread evenly across a
 * horizontalFovDeg x verticalFovDeg cone centered on `forward`, all
 * expressed in the given local east/north/up basis (already rotated into
 * world space by the caller — see ViewAnalyzer).
 */
export function generateFovDirections(
  forward: Cesium.Cartesian3,
  up: Cesium.Cartesian3,
  rayCount: number,
  horizontalFovDeg: number,
  verticalFovDeg: number
): Cesium.Cartesian3[] {
  const right = Cesium.Cartesian3.cross(forward, up, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(right, right);
  const trueUp = Cesium.Cartesian3.cross(right, forward, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(trueUp, trueUp);

  const cols = Math.max(1, Math.round(Math.sqrt((rayCount * horizontalFovDeg) / verticalFovDeg)));
  const rows = Math.max(1, Math.round(rayCount / cols));

  const halfHRad = Cesium.Math.toRadians(horizontalFovDeg) / 2;
  const halfVRad = Cesium.Math.toRadians(verticalFovDeg) / 2;

  const directions: Cesium.Cartesian3[] = [];
  for (let row = 0; row < rows; row++) {
    const v = rows === 1 ? 0 : (row / (rows - 1)) * 2 - 1; // -1..1
    const pitch = v * halfVRad;
    for (let col = 0; col < cols; col++) {
      const h = cols === 1 ? 0 : (col / (cols - 1)) * 2 - 1; // -1..1
      const yaw = h * halfHRad;

      // Rotate `forward` by yaw around trueUp, then by pitch around right.
      const yawed = rotateAroundAxis(forward, trueUp, yaw);
      const pitched = rotateAroundAxis(yawed, right, pitch);
      directions.push(Cesium.Cartesian3.normalize(pitched, pitched));
    }
  }
  return directions;
}

function rotateAroundAxis(
  vector: Cesium.Cartesian3,
  axis: Cesium.Cartesian3,
  angleRad: number
): Cesium.Cartesian3 {
  const quat = Cesium.Quaternion.fromAxisAngle(axis, angleRad, new Cesium.Quaternion());
  const matrix = Cesium.Matrix3.fromQuaternion(quat, new Cesium.Matrix3());
  return Cesium.Matrix3.multiplyByVector(matrix, vector, new Cesium.Cartesian3());
}

/** Casts one batch of rays from `origin`, yielding periodically. */
export async function castRayBatch(
  scene: Cesium.Scene,
  origin: Cesium.Cartesian3,
  directions: Cesium.Cartesian3[],
  onProgress?: (done: number, total: number) => void
): Promise<RayResult[]> {
  const scenePicking = scene as unknown as SceneWithRayPicking;
  const results: RayResult[] = [];

  for (let i = 0; i < directions.length; i++) {
    const direction = directions[i];
    // Nudge origin slightly along the ray so it doesn't immediately
    // self-intersect the facade/glass the eye sits right next to.
    const nudgedOrigin = Cesium.Cartesian3.add(
      origin,
      Cesium.Cartesian3.multiplyByScalar(direction, 0.25, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const ray = new Cesium.Ray(nudgedOrigin, direction);
    const hit = scenePicking.pickFromRay(ray, []);

    results.push({
      origin: nudgedOrigin,
      direction,
      hitPosition: hit?.position ?? null,
      hitObject: hit?.object ?? null,
      distanceM: hit?.position ? Cesium.Cartesian3.distance(origin, hit.position) : null,
    });

    onProgress?.(i + 1, directions.length);
    if (i % YIELD_EVERY === YIELD_EVERY - 1) {
      await yieldToMain();
    }
  }

  return results;
}
