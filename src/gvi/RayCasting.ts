import * as Cesium from "cesium";

export interface RayHit {
  position: Cesium.Cartesian3;
  distanceM: number;
  object?: unknown;
}

interface RayPickingScene {
  pickFromRay(
    ray: Cesium.Ray,
    exclude?: unknown[]
  ): { position?: Cesium.Cartesian3; object?: unknown } | undefined;
}

export function castSceneRay(
  scene: Cesium.Scene,
  origin: Cesium.Cartesian3,
  direction: Cesium.Cartesian3
): RayHit | null {
  const normalized = Cesium.Cartesian3.normalize(direction, new Cesium.Cartesian3());
  const hit = (scene as unknown as RayPickingScene).pickFromRay(
    new Cesium.Ray(origin, normalized),
    []
  );
  if (!hit?.position) return null;
  return {
    position: hit.position,
    distanceM: Cesium.Cartesian3.distance(origin, hit.position),
    object: hit.object,
  };
}
