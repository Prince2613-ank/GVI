import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import { VegetationLayer as CesiumVegetationLayer } from "../gis/VegetationLayer";
import { TreeHoverInfo } from "../gis/TreeRenderer";

interface TreeHoverPopupProps {
  viewer: Cesium.Viewer | null;
  /**
   * The ref itself, not its current value: App.tsx's
   * handleVegetationLayerReady sets vegetationLayerRef.current without a
   * matching state update to force a re-render (unlike viewerRef, which is
   * always paired with setIsViewerReady), so a `.current`-as-prop value
   * could go stale. Reading `.current` fresh inside the mousemove handler
   * instead sidesteps that entirely.
   */
  vegetationLayerRef: React.RefObject<CesiumVegetationLayer | null>;
}

/**
 * Hover-to-inspect for trees: mirrors WindowOverlay.tsx's established
 * ScreenSpaceEventHandler + scene.pick pattern (MOUSE_MOVE instead of
 * LEFT_CLICK), delegating the actual pick/highlight work to
 * VegetationLayer -> TreeRenderer so this component only owns cursor
 * tracking and the popup's own render.
 */
export function TreeHoverPopup({ viewer, vegetationLayerRef }: TreeHoverPopupProps) {
  const handlerRef = useRef<Cesium.ScreenSpaceEventHandler | null>(null);
  const [hover, setHover] = useState<{ info: TreeHoverInfo; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!viewer) return;

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      const vegetationLayer = vegetationLayerRef.current;
      if (!vegetationLayer) {
        setHover(null);
        return;
      }
      const treeId = vegetationLayer.pickTreeId(movement.endPosition);
      vegetationLayer.setHoveredTree(treeId);
      if (!treeId) {
        setHover(null);
        return;
      }
      const info = vegetationLayer.getTreeHoverInfo(treeId);
      if (!info) {
        setHover(null);
        return;
      }
      setHover({ info, x: movement.endPosition.x, y: movement.endPosition.y });
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handlerRef.current = handler;

    return () => {
      handler.destroy();
      handlerRef.current = null;
      vegetationLayerRef.current?.setHoveredTree(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer]);

  if (!hover) return null;

  const { info, x, y } = hover;
  return (
    <div
      style={{
        position: "absolute",
        left: x + 14,
        top: y + 14,
        pointerEvents: "none",
        background: "rgba(20, 30, 22, 0.92)",
        color: "#eafaec",
        borderRadius: 8,
        padding: "10px 12px",
        fontSize: 12,
        lineHeight: 1.5,
        minWidth: 170,
        boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
        zIndex: 50,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 13 }}>{info.species}</div>
      <div>Height: {info.heightM} m</div>
      <div>Canopy width: {info.canopyWidthM} m</div>
      <div>Health: {info.health}</div>
      <div>Age: {info.age}</div>
      <div>Est. CO₂ uptake: ~{info.estimatedCarbonKgPerYear} kg/yr</div>
      <div style={{ opacity: 0.7, marginTop: 4 }}>Source: {info.source}</div>
    </div>
  );
}
