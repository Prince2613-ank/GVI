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

    // The cursor position from the most recent MOUSE_MOVE. The event itself
    // only records it — the actual pick runs on the timer below, against
    // whatever the latest position is at that moment. A leading-edge
    // throttle would pick against a stale position and leave the tooltip
    // attached to a tree the cursor has already left.
    let latestPosition: Cesium.Cartesian2 | null = null;
    let pickTimer: ReturnType<typeof setTimeout> | null = null;
    let cameraIsMoving = false;

    /**
     * scene.pick (via pickTreeId) performs a real off-screen render pass —
     * it is NOT a cheap CPU-side intersection test. Running it per
     * MOUSE_MOVE event meant rendering the scene twice every frame while
     * the user dragged the camera, which is what made orbiting feel sticky.
     * At PICK_INTERVAL_MS the pick lands well within the delay a hover
     * tooltip is expected to have, at a fraction of the cost.
     */
    const PICK_INTERVAL_MS = 60;

    function clearHover() {
      vegetationLayerRef.current?.setHoveredTree(null);
      setHover(null);
    }

    function runPick() {
      pickTimer = null;
      const vegetationLayer = vegetationLayerRef.current;
      const position = latestPosition;
      if (!vegetationLayer || !position) {
        setHover(null);
        return;
      }
      const treeId = vegetationLayer.pickTreeId(position);
      vegetationLayer.setHoveredTree(treeId);
      if (!treeId) {
        setHover(null);
        return;
      }
      const info = vegetationLayer.getTreeHoverInfo(treeId);
      setHover(info ? { info, x: position.x, y: position.y } : null);
    }

    function schedulePick() {
      if (pickTimer !== null) return; // a pick is already queued; it will use the newest position
      pickTimer = setTimeout(runPick, PICK_INTERVAL_MS);
    }

    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      // Cloned, not aliased: Cesium reuses the same Cartesian2 instance
      // across MOUSE_MOVE events, so holding the reference would leave the
      // deferred pick reading a position that has since been mutated.
      latestPosition = Cesium.Cartesian2.clone(movement.endPosition, latestPosition ?? undefined);
      // While the camera is being dragged the cursor isn't pointing at a
      // stable target anyway, so picking is both expensive and useless.
      if (cameraIsMoving) return;
      schedulePick();
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    handlerRef.current = handler;

    // moveStart/moveEnd fire for any camera motion — mouse drag, zoom, and
    // the programmatic flights the balcony navigator triggers.
    const onMoveStart = () => {
      cameraIsMoving = true;
      if (pickTimer !== null) {
        clearTimeout(pickTimer);
        pickTimer = null;
      }
      clearHover();
    };
    const onMoveEnd = () => {
      cameraIsMoving = false;
      schedulePick(); // re-resolve whatever is now under the resting cursor
    };
    viewer.camera.moveStart.addEventListener(onMoveStart);
    viewer.camera.moveEnd.addEventListener(onMoveEnd);

    return () => {
      if (pickTimer !== null) clearTimeout(pickTimer);
      viewer.camera.moveStart.removeEventListener(onMoveStart);
      viewer.camera.moveEnd.removeEventListener(onMoveEnd);
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
      <div>
        Canopy spread: {info.canopyWidthM} × {info.canopyBreadthM} m
        {!info.crownMeasured && <span style={{ opacity: 0.6 }}> (est.)</span>}
      </div>
      {info.trunkDiameterCm !== null && <div>Trunk: {info.trunkDiameterCm} cm across</div>}
      <div>
        Health: {info.health}
        <span style={{ opacity: 0.6 }}>{info.healthAssessed ? " (surveyed)" : " (est.)"}</span>
      </div>
      <div>Age: {info.age}</div>
      <div>Est. CO₂ uptake: ~{info.estimatedCarbonKgPerYear} kg/yr</div>
      <div style={{ opacity: 0.7, marginTop: 4 }}>Source: {info.source}</div>
    </div>
  );
}
