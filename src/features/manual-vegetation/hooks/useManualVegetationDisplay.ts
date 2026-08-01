import { useCallback, useEffect, useRef } from "react";
import * as Cesium from "cesium";
import { ManualVegetationOverlay } from "../projection/VegetationOverlay";
import { ManualVegetationPolygon } from "../types/ManualVegetationTypes";

/**
 * Imperative (not prop-reactive) control over the saved manual vegetation
 * polygon layer — `showPolygons` is meant to be called directly from
 * "Analyze Nearby Vegetation"'s own handler, the same moment fetched trees
 * are set, so both appear together deterministically instead of depending
 * on a chain of effects/props to line up.
 */
export function useManualVegetationDisplay(viewer: Cesium.Viewer | null) {
  const overlayRef = useRef<ManualVegetationOverlay | null>(null);

  useEffect(() => {
    if (!viewer) return;
    const overlay = new ManualVegetationOverlay(viewer);
    overlayRef.current = overlay;
    return () => {
      overlay.destroy();
      overlayRef.current = null;
    };
  }, [viewer]);

  const showPolygons = useCallback((polygons: ManualVegetationPolygon[]) => {
    overlayRef.current?.renderSaved(polygons, null);
  }, []);

  const hidePolygons = useCallback(() => {
    overlayRef.current?.renderSaved([], null);
  }, []);

  return { showPolygons, hidePolygons };
}
