import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import {
  canopyTargetHeightM,
  clipToCanvas,
  CanopyGVIResult,
  projectToWindow,
} from "../services/gviCanopy";
import { VegetationPoint } from "../services/vegetation";

interface GVIProjectionOverlayProps {
  viewer: Cesium.Viewer | null;
  trees: VegetationPoint[];
  result: CanopyGVIResult | null;
  visible: boolean;
}

/**
 * Debug overlay ("GVI Projection" toggle, off by default): draws the exact
 * screen-space canopy polygons services/gviCanopy.ts scored on the last
 * capture, colored by that tree's visibleFraction — green for the clear
 * portion, red for the occluded portion — directly over the Cesium canvas.
 * Unlike the ground-plane "Visible/Occluded Canopy" coloring in
 * gis/VegetationLayer.ts, this shows the actual image-plane footprint the
 * GVI score's area ratio is computed from.
 */
export function GVIProjectionOverlay({ viewer, trees, result, visible }: GVIProjectionOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!viewer) return;
    const cesiumCanvas = viewer.scene.canvas as HTMLCanvasElement;
    const parent = cesiumCanvas.parentElement;
    if (!parent) return;

    const overlay = document.createElement("canvas");
    overlay.style.position = "absolute";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "1";
    parent.style.position = parent.style.position || "relative";
    parent.appendChild(overlay);
    canvasRef.current = overlay;

    const resize = () => {
      overlay.width = cesiumCanvas.clientWidth;
      overlay.height = cesiumCanvas.clientHeight;
      overlay.style.width = `${cesiumCanvas.clientWidth}px`;
      overlay.style.height = `${cesiumCanvas.clientHeight}px`;
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(cesiumCanvas);

    return () => {
      resizeObserver.disconnect();
      parent.removeChild(overlay);
      canvasRef.current = null;
    };
  }, [viewer]);

  useEffect(() => {
    if (!viewer) return;
    const overlay = canvasRef.current;

    const draw = () => {
      if (!overlay) return;
      const ctx = overlay.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      if (!visible || !result) return;

      for (const tree of trees) {
        if (!tree.canopyPolygon || tree.canopyPolygon.length < 3) continue;
        const treeResult = result.perTreeResult.get(tree.id);
        if (!treeResult) continue;

        const heightM = canopyTargetHeightM(tree, viewer.scene);
        const worldPoints = tree.canopyPolygon.map((p) =>
          Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, heightM)
        );
        const screenPoints = worldPoints
          .map((p) => projectToWindow(viewer.scene, p))
          .filter((p): p is Cesium.Cartesian2 => p !== undefined);
        if (screenPoints.length < 3) continue;

        const clipped = clipToCanvas(screenPoints, overlay.width, overlay.height);
        if (clipped.length < 3) continue;

        const isVisible = treeResult.visibleFraction > 0;
        const strokeColor = isVisible ? "rgba(60, 220, 100, 0.9)" : "rgba(220, 60, 60, 0.9)";
        const fillColor = isVisible
          ? `rgba(60, 220, 100, ${0.15 + 0.35 * treeResult.visibleFraction})`
          : "rgba(220, 60, 60, 0.15)";

        ctx.beginPath();
        ctx.moveTo(clipped[0].x, clipped[0].y);
        for (let i = 1; i < clipped.length; i++) {
          ctx.lineTo(clipped[i].x, clipped[i].y);
        }
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    };

    draw();
    viewer.scene.postRender.addEventListener(draw);
    return () => {
      viewer.scene.postRender.removeEventListener(draw);
    };
  }, [viewer, trees, result, visible]);

  return null;
}
