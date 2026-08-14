import { useEffect, useRef, useState } from "react";
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
  // Mirrors layerRef as state purely so the sync effect below re-runs when
  // the layer comes into existence. A ref assignment triggers no re-render,
  // so keying the sync effect on `summary` alone would silently drop any
  // payload that arrived before this layer existed, leaving the map with no
  // trees until something else happened to change `summary` again.
  const [isLayerReady, setIsLayerReady] = useState(false);

  useEffect(() => {
    if (!viewer) return;
    const layer = new CesiumVegetationLayer(viewer);
    layerRef.current = layer;
    setIsLayerReady(true);
    onLayerReady?.(layer);
    return () => {
      onLayerReady?.(null);
      layer.destroy();
      layerRef.current = null;
      setIsLayerReady(false);
    };
  }, [viewer, onLayerReady]);

  useEffect(() => {
    if (!isLayerReady) return;
    // Fire-and-forget here — this reactive path just keeps the globe in
    // sync with whatever `summary` is. Callers that need to know trees have
    // actually finished rendering (e.g. before a GVI screenshot) call
    // layer.setData() directly themselves and await it instead (see
    // App.tsx's handleAnalyzeNearbyVegetation) — the idempotency guard in
    // VegetationLayer.setData makes calling it twice for the same summary
    // object a cheap no-op, not duplicated work.
    void layerRef.current?.setData(summary);
  }, [summary, isLayerReady]);

  // Every passthrough below depends on isLayerReady, not just its own
  // value. The layer is created only once the Cesium viewer exists, which
  // is AFTER the first render — so on mount these all fired against a null
  // layerRef and did nothing. For a prop that then never changes (the
  // toggles are fixed values), the effect never ran again either, and the
  // setting was lost permanently: hiding the canopy polygons silently had
  // no effect at all. Re-running once the layer appears is what makes the
  // initial value actually apply.
  useEffect(() => {
    layerRef.current?.setObstructed(obstructedIds);
  }, [obstructedIds, isLayerReady]);

  useEffect(() => {
    layerRef.current?.setVisible(visible);
  }, [visible, isLayerReady]);

  useEffect(() => {
    layerRef.current?.setTreesVisible(treesVisible);
  }, [treesVisible, isLayerReady]);

  useEffect(() => {
    layerRef.current?.setCanopyVisible(canopyVisible);
  }, [canopyVisible, isLayerReady]);

  useEffect(() => {
    layerRef.current?.setTreeCentersVisible(treeCentersVisible);
  }, [treeCentersVisible, isLayerReady]);

  useEffect(() => {
    layerRef.current?.setCanopyVisibilityColoring(
      perTreeGviResult,
      showVisibleCanopy,
      showOccludedCanopy
    );
  }, [perTreeGviResult, showVisibleCanopy, showOccludedCanopy, isLayerReady]);

  return null;
}
