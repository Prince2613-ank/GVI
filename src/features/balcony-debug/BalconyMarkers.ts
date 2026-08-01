import * as Cesium from "cesium";
import { BalconyViewpointFeature } from "./BalconyTypes";

const MARKER_PREFIX = "balcony-viewpoint-";
const HIGHLIGHT_PREFIX = "balcony-viewpoint-highlight-";

export function markerEntityId(id: string): string {
  return `${MARKER_PREFIX}${id}`;
}

export function idFromMarkerEntityId(entityId: string): string | null {
  if (!entityId.startsWith(MARKER_PREFIX) || entityId.startsWith(HIGHLIGHT_PREFIX)) return null;
  return entityId.slice(MARKER_PREFIX.length);
}

export function addBalconyMarker(
  viewer: Cesium.Viewer,
  feature: BalconyViewpointFeature
): Cesium.Entity {
  const [longitude, latitude, height] = feature.geometry.coordinates;
  const entityId = markerEntityId(feature.properties.id);
  viewer.entities.removeById(entityId);
  return viewer.entities.add({
    id: entityId,
    name: feature.properties.id,
    position: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
    point: {
      pixelSize: 10,
      color: Cesium.Color.LIME,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 1,
      heightReference: Cesium.HeightReference.NONE,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: feature.properties.id,
      font: "12px sans-serif",
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -12),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

export function removeBalconyMarker(viewer: Cesium.Viewer, id: string): void {
  viewer.entities.removeById(markerEntityId(id));
  removeBalconyHighlight(viewer);
}

export function highlightBalconyMarker(viewer: Cesium.Viewer, feature: BalconyViewpointFeature): void {
  removeBalconyHighlight(viewer);
  const [longitude, latitude, height] = feature.geometry.coordinates;
  viewer.entities.add({
    id: `${HIGHLIGHT_PREFIX}${feature.properties.id}`,
    position: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
    point: {
      pixelSize: 18,
      color: Cesium.Color.TRANSPARENT,
      outlineColor: Cesium.Color.YELLOW,
      outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

export function removeBalconyHighlight(viewer: Cesium.Viewer): void {
  const highlight = viewer.entities.values.find((entity) =>
    entity.id.toString().startsWith(HIGHLIGHT_PREFIX)
  );
  if (highlight) viewer.entities.remove(highlight);
}

export function clearAllBalconyMarkers(viewer: Cesium.Viewer): void {
  const toRemove = viewer.entities.values.filter((entity) =>
    entity.id.toString().startsWith(MARKER_PREFIX)
  );
  toRemove.forEach((entity) => viewer.entities.remove(entity));
}
