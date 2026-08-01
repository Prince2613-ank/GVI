import * as Cesium from "cesium";
import { RayResult } from "./RayCastingEngine";
import { RayClassification } from "./types";

// Optional "Toggle Rays" debug visualization: draws each cast ray as a
// short-lived polyline, green for a green-classified hit, red otherwise.
// A single PolylineCollection is reused across calls so repeated
// analyses don't leak primitives.

const RAY_LENGTH_FALLBACK_M = 60;

export class RayVisualizer {
  private readonly collection: Cesium.PolylineCollection;

  constructor(private readonly viewer: Cesium.Viewer) {
    this.collection = viewer.scene.primitives.add(
      new Cesium.PolylineCollection()
    ) as Cesium.PolylineCollection;
  }

  show(origin: Cesium.Cartesian3, hits: RayResult[], classifications: RayClassification[]): void {
    this.clear();
    hits.forEach((hit, i) => {
      const end =
        hit.hitPosition ??
        Cesium.Cartesian3.add(
          origin,
          Cesium.Cartesian3.multiplyByScalar(
            hit.direction,
            RAY_LENGTH_FALLBACK_M,
            new Cesium.Cartesian3()
          ),
          new Cesium.Cartesian3()
        );
      const isGreen = classifications[i]?.isGreen ?? false;
      this.collection.add({
        positions: [origin, end],
        width: 1,
        material: Cesium.Material.fromType("Color", {
          color: isGreen
            ? Cesium.Color.LIME.withAlpha(0.6)
            : Cesium.Color.ORANGERED.withAlpha(0.4),
        }),
      });
    });
  }

  clear(): void {
    this.collection.removeAll();
  }

  destroy(): void {
    if (!this.viewer.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.collection);
    }
  }
}
