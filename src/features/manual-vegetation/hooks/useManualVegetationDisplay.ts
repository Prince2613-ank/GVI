import { useCallback, useEffect, useRef, useState } from "react";
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
  // renderSaved's own chunked, far-to-near progressive render (see
  // VegetationOverlay.ts) already gets polygons on screen chunk by chunk
  // instead of all-at-once — this tracks whether that whole pass (fast
  // paint + background precise-height upgrade) is still in flight. Callers
  // (App.tsx) call showPolygons fire-and-forget, so without this there's
  // no way to know the render is still settling after the caller's own
  // loading state has already moved on.
  const [isLoadingPolygons, setIsLoadingPolygons] = useState(false);

  useEffect(() => {
    if (!viewer) return;
    const overlay = new ManualVegetationOverlay(viewer);
    overlayRef.current = overlay;
    return () => {
      overlay.destroy();
      overlayRef.current = null;
    };
  }, [viewer]);

  // Returns the render promise so callers that need polygons to be fully
  // on screen — not just "started" — before proceeding (e.g. capturing a
  // screenshot for GVI) can await it instead of firing and forgetting.
  const showPolygons = useCallback((polygons: ManualVegetationPolygon[]): Promise<void> => {
    setIsLoadingPolygons(true);
    const done = overlayRef.current?.renderSaved(polygons, null) ?? Promise.resolve();
    void done.finally(() => setIsLoadingPolygons(false));
    return done;
  }, []);

  const hidePolygons = useCallback(() => {
    overlayRef.current?.renderSaved([], null);
  }, []);

  return { showPolygons, hidePolygons, isLoadingPolygons };
}
