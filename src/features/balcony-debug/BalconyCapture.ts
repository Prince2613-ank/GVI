import * as Cesium from "cesium";
import { BalconySide, BalconyViewpointFeature } from "./BalconyTypes";

export function pickBalconyPosition(
  viewer: Cesium.Viewer,
  screenPosition: Cesium.Cartesian2
): { longitude: number; latitude: number; height: number } | null {
  const cartesian = viewer.scene.pickPositionSupported
    ? viewer.scene.pickPosition(screenPosition)
    : viewer.camera.pickEllipsoid(screenPosition, viewer.scene.globe.ellipsoid);
  if (!cartesian) return null;

  const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
  return {
    longitude: Cesium.Math.toDegrees(cartographic.longitude),
    latitude: Cesium.Math.toDegrees(cartographic.latitude),
    height: cartographic.height,
  };
}

/**
 * Screenshots ONLY the Cesium canvas (no UI panels/buttons/sidebars, since
 * those live in separate DOM elements the canvas knows nothing about),
 * downscaled to a small thumbnail size and re-encoded as JPEG to keep
 * localStorage usage reasonable across many saved viewpoints.
 */
export function capturePreviewImage(
  viewer: Cesium.Viewer,
  targetWidth = 400,
  targetHeight = 225,
  quality = 0.8
): string {
  viewer.render();
  const sourceCanvas = viewer.scene.canvas;
  const scratch = document.createElement("canvas");
  scratch.width = targetWidth;
  scratch.height = targetHeight;
  const ctx = scratch.getContext("2d");
  if (!ctx) return sourceCanvas.toDataURL("image/jpeg", quality);
  ctx.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, 0, 0, targetWidth, targetHeight);
  return scratch.toDataURL("image/jpeg", quality);
}

export function makeBalconyFeature(
  id: string,
  floor: number,
  side: BalconySide,
  balcony: number,
  position: { longitude: number; latitude: number; height: number },
  extra?: { previewImage?: string; capturedAt?: number; gviScore?: number }
): BalconyViewpointFeature {
  return {
    type: "Feature",
    properties: {
      id,
      floor,
      side,
      balcony,
      type: "balcony_viewpoint",
      previewImage: extra?.previewImage,
      capturedAt: extra?.capturedAt,
      gviScore: extra?.gviScore,
    },
    geometry: {
      type: "Point",
      coordinates: [position.longitude, position.latitude, position.height],
    },
  };
}
