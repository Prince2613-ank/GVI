import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import { VegetationSummary } from "../services/vegetation";
import { VegetationLayer as CesiumVegetationLayer } from "../gis/VegetationLayer";
import { TreeGVIResult } from "../services/gviCanopy";

interface VegetationLayerProps {
  viewer: Cesium.Viewer | null;
  summary: VegetationSummary | null;
  obstructedIds?: Set<string>;
  visible?: boolean;
  onLayerReady?: (layer: CesiumVegetationLayer | null) => void;
  /** Debug toggles — see components/CanopyDebugPanel.tsx. */
  treesVisible?: boolean;
  canopyVisible?: boolean;
  treeCentersVisible?: boolean;
  showVisibleCanopy?: boolean;
  showOccludedCanopy?: boolean;
  perTreeGviResult?: Map<string, TreeGVIResult> | null;
}

/** React lifecycle adapter around the batched Cesium vegetation layer. */
export function VegetationLayer({
  viewer,
  summary,
  obstructedIds,
  visible = true,
  onLayerReady,
  treesVisible = true,
  canopyVisible = true,
  treeCentersVisible = false,
  showVisibleCanopy = true,
  showOccludedCanopy = true,
  perTreeGviResult = null,
}: VegetationLayerProps) {
  const layerRef = useRef<CesiumVegetationLayer | null>(null);

  useEffect(() => {
    if (!viewer) return;
    const layer = new CesiumVegetationLayer(viewer);
    layerRef.current = layer;
    onLayerReady?.(layer);
    return () => {
      onLayerReady?.(null);
      layer.destroy();
      layerRef.current = null;
    };
  }, [viewer, onLayerReady]);

  useEffect(() => {
    // Fire-and-forget here — this reactive path just keeps the globe in
    // sync with whatever `summary` is. Callers that need to know trees have
    // actually finished rendering (e.g. before a GVI screenshot) call
    // layer.setData() directly themselves and await it instead (see
    // App.tsx's handleAnalyzeNearbyVegetation) — the idempotency guard in
    // VegetationLayer.setData makes calling it twice for the same summary
    // object a cheap no-op, not duplicated work.
    void layerRef.current?.setData(summary);
  }, [summary]);

  useEffect(() => {
    layerRef.current?.setObstructed(obstructedIds);
  }, [obstructedIds]);

  useEffect(() => {
    layerRef.current?.setVisible(visible);
  }, [visible]);

  useEffect(() => {
    layerRef.current?.setTreesVisible(treesVisible);
  }, [treesVisible]);

  useEffect(() => {
    layerRef.current?.setCanopyVisible(canopyVisible);
  }, [canopyVisible]);

  useEffect(() => {
    layerRef.current?.setTreeCentersVisible(treeCentersVisible);
  }, [treeCentersVisible]);

  useEffect(() => {
    layerRef.current?.setCanopyVisibilityColoring(
      perTreeGviResult,
      showVisibleCanopy,
      showOccludedCanopy
    );
  }, [perTreeGviResult, showVisibleCanopy, showOccludedCanopy]);

  return null;
}
