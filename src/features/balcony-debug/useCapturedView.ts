import { useCallback, useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import { CaptureStatus, CapturedView } from "./CapturedViewTypes";
import { ManualVegetationPolygon } from "../manual-vegetation/types/ManualVegetationTypes";
import { projectManualVegetation } from "../manual-vegetation/projection/ProjectionService";
import { suspendForCapture, resumeAfterCapture } from "../sunlight-analysis/sunlightEffects";

const TOAST_DURATION_MS = 3000;

/**
 * Freeform "capture whatever's on screen right now" workflow — independent
 * of balcony viewpoints entirely. Only ever holds the single latest
 * capture (retaking replaces it, never accumulates), so this is safe to
 * call repeatedly without leaking memory across a long session.
 */
export function useCapturedView() {
  const [capturedView, setCapturedView] = useState<CapturedView | null>(null);
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus>("idle");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    };
  }, []);

  const captureCurrentView = useCallback(
    (
      viewer: Cesium.Viewer | null,
      manualVegetationPolygons: ManualVegetationPolygon[] = []
    ): CapturedView | null => {
      if (!viewer) {
        setCaptureStatus("error");
        setCaptureError("Unable to capture current view.");
        return null;
      }

      setCaptureStatus("capturing");
      setCaptureError(null);

      // If the Sunlight Analysis cinematic effect is currently running, its
      // real shadow-mapped lighting darkens canopy pixels enough to fail
      // the HSV vegetation thresholds below — a GVI score computed from
      // that frame reads far too low (shadowed canopy looks "not green").
      // Suspend it for exactly this one capture frame and put it back
      // immediately after, so GVI stays accurate regardless of whatever
      // the sunlight panel is doing.
      const wasSuspended = suspendForCapture(viewer);

      try {
        // Forces an immediate, synchronous render right before reading the
        // canvas. Needed because Cesium's requestRenderMode defers its next
        // render to the browser's own next frame — without this, a capture
        // taken in the same tick as a camera move (or any other change that
        // hasn't been drawn yet) could read a stale frame instead of what's
        // actually being requested. viewer.scene.render() (not
        // requestRender()) is what makes this synchronous.
        viewer.scene.render();
        const canvas = viewer.scene.canvas as HTMLCanvasElement;
        const image = canvas.toDataURL("image/png");
        const camera = viewer.camera;
        const cartographic = Cesium.Cartographic.fromCartesian(camera.positionWC);

        // Must happen NOW, against the live camera — this is the only
        // moment it's guaranteed to match what's actually in `image`.
        const manualVegetationMask =
          manualVegetationPolygons.length > 0
            ? projectManualVegetation(viewer, manualVegetationPolygons, canvas.width, canvas.height)
            : undefined;

        const next: CapturedView = {
          id: `capture-${Date.now()}`,
          image,
          width: canvas.width,
          height: canvas.height,
          timestamp: Date.now(),
          camera: {
            longitude: Cesium.Math.toDegrees(cartographic.longitude),
            latitude: Cesium.Math.toDegrees(cartographic.latitude),
            height: cartographic.height,
            heading: Cesium.Math.toDegrees(camera.heading),
            pitch: Cesium.Math.toDegrees(camera.pitch),
            roll: Cesium.Math.toDegrees(camera.roll),
          },
          manualVegetationMask,
        };

        // Replaces whatever was captured before — only the latest is ever kept.
        setCapturedView(next);
        setCaptureStatus("success");
        // Returned directly (not just left for callers to read back off
        // `capturedView` state) so a caller chaining straight into analysis
        // right after capturing doesn't race React's next render — state
        // updates here are async, this return value isn't.
        return next;
      } catch {
        setCaptureStatus("error");
        setCaptureError("Unable to capture current view.");
        if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
        toastTimeoutRef.current = setTimeout(() => setCaptureError(null), TOAST_DURATION_MS);
        return null;
      } finally {
        if (wasSuspended) resumeAfterCapture(viewer);
      }
    },
    []
  );

  const clearCapture = useCallback(() => {
    setCapturedView(null);
    setCaptureStatus("idle");
    setCaptureError(null);
  }, []);

  const hasCapture = useCallback(() => capturedView !== null, [capturedView]);
  const getCapturedImage = useCallback(() => capturedView?.image ?? null, [capturedView]);

  return {
    capturedView,
    captureStatus,
    captureError,
    captureCurrentView,
    clearCapture,
    hasCapture,
    getCapturedImage,
  };
}
