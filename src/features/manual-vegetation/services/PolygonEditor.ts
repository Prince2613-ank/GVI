import * as Cesium from "cesium";
import { LonLat } from "../types/ManualVegetationTypes";

/** Picks a world position off whatever's under the cursor (ground/building), same technique as the balcony capture flow. */
export function pickGroundPosition(
  viewer: Cesium.Viewer,
  screenPosition: Cesium.Cartesian2
): LonLat | null {
  const cartesian = viewer.scene.pickPositionSupported
    ? viewer.scene.pickPosition(screenPosition)
    : viewer.camera.pickEllipsoid(screenPosition, viewer.scene.globe.ellipsoid);
  if (!cartesian) return null;

  const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
  return {
    longitude: Cesium.Math.toDegrees(cartographic.longitude),
    latitude: Cesium.Math.toDegrees(cartographic.latitude),
  };
}
