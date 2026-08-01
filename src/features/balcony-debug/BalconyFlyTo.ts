import * as Cesium from "cesium";
import { BalconyViewpointFeature } from "./BalconyTypes";
import { indoorCamera } from "../indoor-camera/IndoorCameraController";

/**
 * headingRad, when given, faces the camera straight out through that flat's
 * facade instead of keeping whatever heading the camera already had.
 *
 * Every balcony/window viewpoint counts as "indoor" for navigation purposes
 * — once the flight lands, Indoor Camera Mode takes over (slow, clamped
 * mouse-wheel steps instead of Cesium's default fast zoom) until the user
 * flies back out (see the Home button override in useCesium.ts).
 */
export function flyToBalcony(
  viewer: Cesium.Viewer,
  feature: BalconyViewpointFeature,
  headingRad?: number
): void {
  const [longitude, latitude, height] = feature.geometry.coordinates;
  const destination = Cesium.Cartesian3.fromDegrees(longitude, latitude, height);
  viewer.camera.flyTo({
    destination,
    orientation: {
      heading: headingRad ?? viewer.camera.heading,
      pitch: Cesium.Math.toRadians(-5),
      roll: 0,
    },
    duration: 1.5,
    complete: () => indoorCamera.enter(viewer, height, feature.properties.side),
  });
}
