import { useCallback, useRef, useState } from "react";
import * as Cesium from "cesium";
import { CesiumViewer } from "../../components/CesiumViewer";
import { INITIAL_BUILDING } from "../../config/building";
import { computeWindowCameraPose, flyCameraToPose } from "../../services/camera";
import { waitForSemanticRender } from "../../services/semanticMask";
import { computeGVIFromDataUrl } from "../../services/gvi";
import { capturePreviewImage } from "./BalconyCapture";
import { CardinalDirection } from "../../utils/constants";
import { BALCONIES_PER_SIDE } from "./BalconyTypes";

export interface AutomationCaptureResult {
  ok: boolean;
  error?: string;
  previewImageDataUrl?: string;
  maskImageDataUrl?: string;
  width?: number;
  height?: number;
  gviScore?: number;
  greenPixelCount?: number;
  greyPixelCount?: number;
  totalPixelCount?: number;
  camera?: {
    longitude: number;
    latitude: number;
    height: number;
    heading: number;
    pitch: number;
    roll: number;
  };
}

declare global {
  interface Window {
    /** Exposed by the Puppeteer worker before navigation; called exactly once when this run finishes (success or failure). */
    __reportBalconyCapture?: (result: AutomationCaptureResult) => void;
  }
}

const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;
const CAPTURE_QUALITY = 0.9;
/** Extra dwell after the two-frame render settle, giving streamed 3D-tile/imagery detail more time to resolve before capture. */
const EXTRA_SETTLE_MS = 1200;

function facadeRatioForBalcony(balcony: number): number {
  return (balcony - (BALCONIES_PER_SIDE + 1) / 2) / ((BALCONIES_PER_SIDE - 1) / 2 || 1);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AutomationParams {
  floor: number;
  direction: CardinalDirection;
  flat: number;
  /**
   * Overrides the auto-computed formula position with an exact lon/lat/height
   * — used when the backend's stored viewpoint position came from a manual
   * capture in the Live Balcony Position Debug tool (synced in via
   * /import-positions) rather than the generic per-floor/side/flat formula.
   * Heading/pitch/roll are still derived from direction via the same
   * formula either way, since those don't depend on manual position nudges.
   */
  overridePosition?: { longitude: number; latitude: number; height: number };
}

/**
 * Parses ?automation=1&floor=&direction=&flat=[&lon=&lat=&h=] from the
 * current URL. Returns null if this isn't an automation run (the normal App
 * renders instead).
 */
export function parseAutomationParams(search: string): AutomationParams | null {
  const params = new URLSearchParams(search);
  if (params.get("automation") !== "1") return null;
  const floor = Number(params.get("floor"));
  const direction = params.get("direction") as CardinalDirection;
  const flat = Number(params.get("flat"));
  const validDirections: CardinalDirection[] = ["North", "South", "East", "West"];
  if (!Number.isFinite(floor) || !validDirections.includes(direction) || !Number.isFinite(flat)) {
    return null;
  }

  const lon = Number(params.get("lon"));
  const lat = Number(params.get("lat"));
  const h = Number(params.get("h"));
  const overridePosition =
    Number.isFinite(lon) && Number.isFinite(lat) && Number.isFinite(h)
      ? { longitude: lon, latitude: lat, height: h }
      : undefined;

  return { floor, direction, flat, overridePosition };
}

/**
 * Renders ONLY the Cesium canvas — no debug panels, no navigator, no
 * buttons — so a Puppeteer-driven screenshot never has to worry about
 * cropping out UI chrome. Loads once per browser tab/page; the worker opens
 * a fresh page per job so there's no state to reset between viewpoints.
 *
 * Flow: fly to the exact floor/direction/flat pose (same math as the
 * interactive navigator) -> wait for the render to settle -> capture the
 * canvas -> run the existing pixel-classification GVI pipeline on that
 * capture -> report everything back to the backend worker via a
 * page-exposed function.
 */
export function AutomationHarness({ floor, direction, flat, overridePosition }: AutomationParams) {
  const [hasRun, setHasRun] = useState(false);
  const viewerRef = useRef<Cesium.Viewer | null>(null);

  const report = useCallback((result: AutomationCaptureResult) => {
    if (typeof window.__reportBalconyCapture === "function") {
      window.__reportBalconyCapture(result);
    } else {
      // No harness attached (e.g. opened directly in a browser for manual
      // debugging) — surface the result visibly instead of doing nothing.
      // eslint-disable-next-line no-console
      console.log("[AutomationHarness] capture result", result);
    }
  }, []);

  const runCapture = useCallback(
    async (viewer: Cesium.Viewer) => {
      try {
        const pose = computeWindowCameraPose(INITIAL_BUILDING, floor, direction, {
          facadeOffsetRatio: facadeRatioForBalcony(flat),
        });
        if (overridePosition) {
          pose.position = Cesium.Cartesian3.fromDegrees(
            overridePosition.longitude,
            overridePosition.latitude,
            overridePosition.height
          );
        }
        await flyCameraToPose(viewer, pose, 1.0);

        viewer.scene.requestRender();
        await waitForSemanticRender(viewer);
        await wait(EXTRA_SETTLE_MS);
        viewer.scene.requestRender();
        await waitForSemanticRender(viewer);

        const previewImageDataUrl = capturePreviewImage(
          viewer,
          CAPTURE_WIDTH,
          CAPTURE_HEIGHT,
          CAPTURE_QUALITY
        );
        const gvi = await computeGVIFromDataUrl(previewImageDataUrl, { generateMask: true });

        const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
        report({
          ok: true,
          previewImageDataUrl,
          maskImageDataUrl: gvi.maskDataUrl,
          width: CAPTURE_WIDTH,
          height: CAPTURE_HEIGHT,
          gviScore: gvi.gviScore,
          greenPixelCount: gvi.greenPixelCount,
          greyPixelCount: gvi.greyPixelCount ?? gvi.totalPixelCount - gvi.greenPixelCount,
          totalPixelCount: gvi.totalPixelCount,
          camera: {
            longitude: Cesium.Math.toDegrees(cartographic.longitude),
            latitude: Cesium.Math.toDegrees(cartographic.latitude),
            height: cartographic.height,
            heading: pose.heading,
            pitch: pose.pitch,
            roll: pose.roll,
          },
        });
      } catch (error) {
        report({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
    [floor, direction, flat, report]
  );

  const handleViewerReady = useCallback(
    (viewer: Cesium.Viewer) => {
      viewerRef.current = viewer;
      if (hasRun) return;
      setHasRun(true);
      void runCapture(viewer);
    },
    [hasRun, runCapture]
  );

  return (
    <CesiumViewer
      building={INITIAL_BUILDING}
      onViewerReady={handleViewerReady}
      onBuildingEntityReady={() => {}}
    />
  );
}
