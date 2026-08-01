import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import { BuildingTransform } from "../../services/camera";
import { localOffsetToWorldPosition } from "./frame";
import { ResultStore } from "./ResultStore";
import { WindowMetadata } from "./types";

// Renders every window as a small point marker on the Cesium scene (per
// spec: "small blue marker", recolored into the heatmap once analyzed).
// Uses a single Cesium.PointPrimitiveCollection rather than one Entity per
// window — entities carry far more per-instance overhead, and the spec
// explicitly calls out supporting 5000+ windows.

const UNANALYZED_COLOR = Cesium.Color.DODGERBLUE;

function heatmapColor(gviPercent: number): Cesium.Color {
  if (gviPercent < 20) return Cesium.Color.fromCssColorString("#e53935"); // red
  if (gviPercent < 40) return Cesium.Color.fromCssColorString("#fb8c00"); // orange
  if (gviPercent < 60) return Cesium.Color.fromCssColorString("#fdd835"); // yellow
  if (gviPercent < 80) return Cesium.Color.fromCssColorString("#9ccc65"); // light green
  return Cesium.Color.fromCssColorString("#2e7d32"); // dark green
}

interface WindowOverlayProps {
  viewer: Cesium.Viewer | null;
  building: BuildingTransform;
  windows: WindowMetadata[];
  resultStore: ResultStore;
  heatmapEnabled: boolean;
  selectedWindowId: string | null;
  onSelectWindow: (windowId: string) => void;
}

export function WindowOverlay({
  viewer,
  building,
  windows,
  resultStore,
  heatmapEnabled,
  selectedWindowId,
  onSelectWindow,
}: WindowOverlayProps) {
  const collectionRef = useRef<Cesium.PointPrimitiveCollection | null>(null);
  const pointsByIdRef = useRef<Map<string, Cesium.PointPrimitive>>(new Map());
  const handlerRef = useRef<Cesium.ScreenSpaceEventHandler | null>(null);

  // Create/destroy the point collection and click handler once per viewer.
  useEffect(() => {
    if (!viewer) return;
    const collection = viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection()
    ) as Cesium.PointPrimitiveCollection;
    collectionRef.current = collection;

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = viewer.scene.pick(movement.position);
      const id = picked?.id;
      if (typeof id === "string" && id.startsWith("window-gvi-")) {
        onSelectWindow(id.replace("window-gvi-", ""));
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    handlerRef.current = handler;

    return () => {
      handler.destroy();
      handlerRef.current = null;
      if (!viewer.isDestroyed()) {
        viewer.scene.primitives.remove(collection);
      }
      collectionRef.current = null;
      pointsByIdRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);

  // Rebuild points when the window list or building transform changes.
  useEffect(() => {
    const collection = collectionRef.current;
    if (!collection) return;
    collection.removeAll();
    pointsByIdRef.current.clear();

    for (const w of windows) {
      const position = localOffsetToWorldPosition(
        building,
        w.position[0],
        w.position[1],
        w.position[2]
      );
      const point = collection.add({
        id: `window-gvi-${w.id}`,
        position,
        color: UNANALYZED_COLOR,
        pixelSize: 8,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1,
      });
      pointsByIdRef.current.set(w.id, point);
    }
  }, [windows, building]);

  // Recolor for heatmap / selection whenever results, the toggle, or the
  // selection change — subscribes to the store so results computed
  // asynchronously (batched analysis) repaint live.
  useEffect(() => {
    function repaint() {
      for (const [id, point] of pointsByIdRef.current.entries()) {
        const result = resultStore.get(id);
        if (heatmapEnabled && result) {
          point.color = heatmapColor(result.averageGviPercent);
        } else {
          point.color = UNANALYZED_COLOR;
        }
        const isSelected = id === selectedWindowId;
        point.pixelSize = isSelected ? 14 : 8;
        point.outlineWidth = isSelected ? 3 : 1;
        point.outlineColor = isSelected ? Cesium.Color.CYAN : Cesium.Color.WHITE;
      }
    }
    repaint();
    return resultStore.subscribe(repaint);
  }, [resultStore, heatmapEnabled, selectedWindowId, windows]);

  return null;
}
