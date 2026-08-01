import { useEffect, useState } from "react";
import * as Cesium from "cesium";
import {
  addBalconyMarker,
  clearAllBalconyMarkers,
  highlightBalconyMarker,
  idFromMarkerEntityId,
  removeBalconyHighlight,
} from "./BalconyMarkers";
import { BalconyViewpointCollection } from "./BalconyTypes";

interface UseBalconyMarkersOptions {
  viewer: Cesium.Viewer | null;
  collection: BalconyViewpointCollection;
  onDeleteRequested: (id: string) => void;
}

export function useBalconyMarkers({ viewer, collection, onDeleteRequested }: UseBalconyMarkersOptions) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!viewer) return;
    clearAllBalconyMarkers(viewer);
    collection.features.forEach((feature) => addBalconyMarker(viewer, feature));
    return () => clearAllBalconyMarkers(viewer);
  }, [viewer, collection]);

  useEffect(() => {
    if (!viewer) return;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = viewer.scene.pick(event.position);
      const entityId: string | undefined = picked?.id?.id;
      const id = entityId ? idFromMarkerEntityId(entityId) : null;
      if (id) {
        const feature = collection.features.find((f) => f.properties.id === id);
        if (feature) {
          highlightBalconyMarker(viewer, feature);
          setSelectedId(id);
          return;
        }
      }
      removeBalconyHighlight(viewer);
      setSelectedId(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    return () => handler.destroy();
  }, [viewer, collection]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Delete" && selectedId) {
        onDeleteRequested(selectedId);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, onDeleteRequested]);

  const selectedFeature =
    collection.features.find((f) => f.properties.id === selectedId) ?? null;

  function clearSelection() {
    if (viewer) removeBalconyHighlight(viewer);
    setSelectedId(null);
  }

  function selectById(id: string) {
    const feature = collection.features.find((f) => f.properties.id === id);
    if (!feature) return;
    if (viewer) highlightBalconyMarker(viewer, feature);
    setSelectedId(id);
  }

  return { selectedId, selectedFeature, clearSelection, selectById };
}
