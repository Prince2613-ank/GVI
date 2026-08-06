import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import { CesiumViewer } from "./components/CesiumViewer";
import { VegetationLayer } from "./components/VegetationLayer";
import { VegetationLayer as CesiumVegetationLayer } from "./gis/VegetationLayer";
import { TreeHoverPopup } from "./components/TreeHoverPopup";
import { SunlightAnalysisPanel } from "./features/sunlight-analysis/SunlightAnalysisPanel";
// Lazy-loaded: the balcony-debug feature folder is ~3400 lines (viewpoint
// navigation, saved views, GVI ranking, automation harness) — splitting it
// into its own chunk means the browser doesn't have to download/parse it
// before the map itself can render, since Vite/Rollup puts a dynamic
// import() in a separate chunk fetched in parallel rather than blocking
// the main bundle.
const BalconyViewpointNavigator = lazy(() =>
  import("./features/balcony-debug/BalconyViewpointNavigator").then((m) => ({
    default: m.BalconyViewpointNavigator,
  }))
);
import { IndoorNavigationOverlay } from "./features/indoor-navigation/IndoorNavigationOverlay";
import { BalconySide, BalconyViewpointCollection } from "./features/balcony-debug/BalconyTypes";
import {
  loadBalconyCollection,
  saveBalconyCollection,
} from "./features/balcony-debug/BalconyStorage";
import { useManualVegetationDisplay } from "./features/manual-vegetation/hooks/useManualVegetationDisplay";
import { ManualVegetationCollection } from "./features/manual-vegetation/types/ManualVegetationTypes";
import {
  loadManualVegetationCollection,
  listManualVegetationPolygons,
} from "./features/manual-vegetation/storage/VegetationStorage";
import { CanopyDebugToggles } from "./components/CanopyDebugPanel";
import { GVIProjectionOverlay } from "./components/GVIProjectionOverlay";
import { useVegetation } from "./hooks/useVegetation";
import { BuildingTransform, facadeLocalOffset } from "./services/camera";
import { CanopyGVIResult } from "./services/gviCanopy";
import { VegetationPoint } from "./services/vegetation";
import {
  CardinalDirection,
  FLOOR_HEIGHT_M,
  MODEL_BASE_OFFSET_M,
} from "./utils/constants";
import { computeCameraHeightM } from "./utils/cameraUtils";
import { INITIAL_BUILDING } from "./config/building";
import "./styles.css";


export default function App() {
  const [building] = useState<BuildingTransform>(INITIAL_BUILDING);
  const [floor] = useState(1);
  const [direction] = useState<CardinalDirection>("North");
  const [canopyGviResult] = useState<CanopyGVIResult | null>(null);
  const [balconyCollection, setBalconyCollection] = useState<BalconyViewpointCollection>(
    loadBalconyCollection
  );
  const persistBalconyCollection = useCallback((next: BalconyViewpointCollection) => {
    setBalconyCollection(next);
    saveBalconyCollection(next);
  }, []);
  const [manualVegetationCollection] = useState<ManualVegetationCollection>(loadManualVegetationCollection);
  // Shared between the Balcony Viewpoints navigator and the Live Balcony
  // Position Debug card, so clicking "Go to" in one auto-selects the same
  // floor/side/flat in the other — ready to hit "Save Point" immediately.
  const [balconyFloor, setBalconyFloor] = useState(1);
  const [balconySide, setBalconySide] = useState<BalconySide>("North");
  const [balconyFlat, setBalconyFlat] = useState(1);

  const [debugToggles] = useState<CanopyDebugToggles>({
    treeCenters: false,
    canopyPolygons: true,
    trees3D: true,
    visibleCanopy: true,
    occludedCanopy: true,
    gviProjection: false,
  });

  // Line-of-sight analysis previously ran continuously (see the removed
  // runVisibilityAnalysis) to populate these — kept as permanently-empty
  // state so VegetationLayer/the viewshed-polygon effect below still have a
  // well-typed value to read, without the heavy per-tree ray-casting that
  // used to compute them on every "Analyze Nearby Vegetation" click.
  const [obstructedTreeIds] = useState<Set<string>>(new Set());
  const [viewshedPolygon] = useState<{ latitude: number; longitude: number }[] | null>(null);

  // Plain ref for synchronous reads inside callbacks/effects; the boolean
  // twin below exists purely so effects can react to the viewer becoming
  // ready (a ref mutation alone never re-triggers a dependent effect).
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const [isViewerReady, setIsViewerReady] = useState(false);
  const [viewerInitError, setViewerInitError] = useState<string | null>(null);
  const handleViewerInitError = useCallback((message: string) => {
    setViewerInitError(message);
  }, []);
  const radiusEntityRef = useRef<Cesium.Entity | null>(null);
  const windowHighlightRef = useRef<Cesium.Entity | null>(null);
  const vegetationLayerRef = useRef<CesiumVegetationLayer | null>(null);
  const [isVegetationLayerReady, setIsVegetationLayerReady] = useState(false);
  const handleVegetationLayerReady = useCallback(
    (layer: CesiumVegetationLayer | null) => {
      vegetationLayerRef.current = layer;
      setIsVegetationLayerReady(layer !== null);
    },
    []
  );
  const { summary, state: vegetationState, errorMessage: vegetationError, refetch } = useVegetation(
    building.latitude,
    building.longitude,
    { autoFetch: false }
  );

  const handleViewerReady = useCallback((viewer: Cesium.Viewer) => {
    viewerRef.current = viewer;
    setIsViewerReady(true);
  }, []);

  // The surrounding-city white building masses are actually rendered by
  // this tileset (OSM Buildings 3D Tiles), not by any Entity layer — the
  // Sunlight Analysis panel needs a direct handle to it to tint them for
  // day/night, since 3D Tiles don't pick up scene.light shading the way
  // Entity polygons do.
  const osmBuildingsRef = useRef<Cesium.Cesium3DTileset | null>(null);
  const [isOsmBuildingsReady, setIsOsmBuildingsReady] = useState(false);
  const handleOsmBuildingsReady = useCallback((tileset: Cesium.Cesium3DTileset) => {
    osmBuildingsRef.current = tileset;
    setIsOsmBuildingsReady(true);
  }, []);

  const buildingEntityRef = useRef<Cesium.Entity | null>(null);
  const [, forceBuildingEntityRerender] = useState(0);

  const handleBuildingEntityReady = useCallback((entity: Cesium.Entity) => {
    buildingEntityRef.current = entity;
    forceBuildingEntityRerender((n) => n + 1);
  }, []);

  // Renders the "eye sight" viewshed polygon computed by runVisibilityAnalysis
  // below — the real unobstructed-sightline extent from the current eye
  // position, not a flat search-radius circle. Recomputed after every
  // floor/direction/viewpoint change once the camera settles.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (radiusEntityRef.current) {
      viewer.entities.remove(radiusEntityRef.current);
      radiusEntityRef.current = null;
    }

    if (!viewshedPolygon || viewshedPolygon.length < 3) return;

    const positions = viewshedPolygon.map((p) =>
      Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude)
    );

    radiusEntityRef.current = viewer.entities.add({
      polygon: {
        hierarchy: positions,
        material: Cesium.Color.YELLOW.withAlpha(0.1),
        outline: true,
        outlineColor: Cesium.Color.YELLOW.withAlpha(0.7),
        height: 0,
      },
    });
  }, [viewshedPolygon]);

  // BONUS: highlight the selected window facade with a translucent box.
  // Uses the same MODEL_BASE_OFFSET_M-corrected height as the camera pose
  // (see services/camera.ts) so the highlight actually sits on the facade
  // instead of floating near the building's unrelated entity origin.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    if (windowHighlightRef.current) {
      viewer.entities.remove(windowHighlightRef.current);
    }

    const baseOffsetM = MODEL_BASE_OFFSET_M * building.scale;
    const facadeCameraHeight = baseOffsetM + computeCameraHeightM(floor, FLOOR_HEIGHT_M, 0);
    const { east: localEast, north: localNorth } = facadeLocalOffset(
      direction,
      building.scale,
      0
    );

    const cosR = Math.cos(building.rotationRad);
    const sinR = Math.sin(building.rotationRad);
    const worldEast = localEast * cosR - localNorth * sinR;
    const worldNorth = localEast * sinR + localNorth * cosR;

    const origin = Cesium.Cartesian3.fromDegrees(
      building.longitude,
      building.latitude,
      building.height + facadeCameraHeight
    );
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
    const position = Cesium.Matrix4.multiplyByPoint(
      enu,
      new Cesium.Cartesian3(worldEast, worldNorth, 0),
      new Cesium.Cartesian3()
    );

    windowHighlightRef.current = viewer.entities.add({
      position,
      box: {
        dimensions: new Cesium.Cartesian3(2, 0.3, 2),
        material: Cesium.Color.CYAN.withAlpha(0.6),
        outline: true,
        outlineColor: Cesium.Color.WHITE,
      },
    });
  }, [
    floor,
    direction,
    building.latitude,
    building.longitude,
    building.height,
    building.rotationRad,
    building.scale,
    isViewerReady,
  ]);

  // This is now the ONLY thing that renders saved manual vegetation polygons
  // on the globe — the debug panel that used to own a second overlay
  // instance (for live draft/handle editing) is no longer mounted in the UI.
  const { showPolygons: showManualVegetation } = useManualVegetationDisplay(
    isViewerReady ? viewerRef.current : null
  );

  // Fetches + renders nearby vegetation, then explicitly (not via a
  // prop-reactive effect) shows every saved manual vegetation polygon at
  // the same moment — both are meant to always appear together. This used
  // to also run runGviCapture/runVisibilityAnalysis (per-tree ray-casting
  // against the 3D scene — potentially thousands of scene picks for a busy
  // 400m radius) on every click, which is what was freezing the page.
  // Neither one's output is surfaced by any control in the current UI (the
  // debug toggle panel that exposed them was removed) — the Balcony GVI
  // features already run their own on-demand analysis independently of
  // this button.
  const handleAnalyzeNearbyVegetation = useCallback(async () => {
    // Render the manual polygons FIRST so they're already on the globe
    // before the tree fetch adds hundreds of canopy ground-primitives —
    // otherwise the newly-loaded canopies can visually paint over the
    // polygon fill in the same frame. Awaited (not fire-and-forget) so
    // callers — the balcony panel's "Analyse GVI" flow, which captures a
    // screenshot and computes GVI right after this resolves — never
    // capture/preview/calculate against a scene where polygons are still
    // mid-render.
    await showManualVegetation(listManualVegetationPolygons(manualVegetationCollection));
    const nextSummary = await refetch();
    // Calling setData directly (rather than relying on the `summary` prop
    // reaching <VegetationLayer> through a React re-render) and awaiting it
    // is what lets this function's returned promise genuinely mean "trees
    // are done rendering" — callers like the balcony panel's "Analyse GVI"
    // button depend on that to avoid capturing a screenshot mid-tessellation
    // (which was producing false/low GVI scores). setData's own idempotency
    // guard means the reactive effect in components/VegetationLayer.tsx
    // calling it again for the same summary is a cheap no-op, not duplicated work.
    if (nextSummary) {
      await vegetationLayerRef.current?.setData(nextSummary);
    }
  }, [refetch, showManualVegetation, manualVegetationCollection]);

  // Camera no longer auto-flies to the floor/window pose on load — that
  // overwrote useCesium's DEFAULT_VIEW aerial shot immediately after it
  // landed. The page-load view is now whatever DEFAULT_VIEW is; the camera
  // only moves via explicit "Go to View" / navigator actions.

  return (
    <div className="app-root">
      <CesiumViewer
        building={building}
        onViewerReady={handleViewerReady}
        onBuildingEntityReady={handleBuildingEntityReady}
        onOsmBuildingsReady={handleOsmBuildingsReady}
        onInitError={handleViewerInitError}
      />
      <IndoorNavigationOverlay />
      <Suspense fallback={null}>
        <BalconyViewpointNavigator
          viewer={viewerRef.current}
          building={building}
          collection={balconyCollection}
          floor={balconyFloor}
          side={balconySide}
          balcony={balconyFlat}
          onFloorChange={setBalconyFloor}
          onSideChange={setBalconySide}
          onBalconyChange={setBalconyFlat}
          onPersistCollection={persistBalconyCollection}
          onAnalyzeVegetation={handleAnalyzeNearbyVegetation}
          isViewerReady={isViewerReady}
          vegetationErrorMessage={vegetationState === "error" ? vegetationError : null}
          manualVegetationCollection={manualVegetationCollection}
        />
      </Suspense>
      <VegetationLayer
        viewer={viewerRef.current}
        summary={summary}
        obstructedIds={obstructedTreeIds}
        onLayerReady={handleVegetationLayerReady}
        treesVisible={debugToggles.trees3D}
        canopyVisible={debugToggles.canopyPolygons}
        treeCentersVisible={debugToggles.treeCenters}
        showVisibleCanopy={debugToggles.visibleCanopy}
        showOccludedCanopy={debugToggles.occludedCanopy}
        perTreeGviResult={canopyGviResult?.perTreeResult ?? null}
      />
      <TreeHoverPopup viewer={viewerRef.current} vegetationLayerRef={vegetationLayerRef} />
      <SunlightAnalysisPanel
        viewer={viewerRef.current}
        osmBuildings={isOsmBuildingsReady ? osmBuildingsRef.current : null}
        vegetationLayer={isVegetationLayerReady ? vegetationLayerRef.current : null}
      />
      <GVIProjectionOverlay
        viewer={viewerRef.current}
        trees={
          summary?.features.filter(
            (f): f is VegetationPoint =>
              f.kind === "point" && (f.category === "tree" || f.category === "street_tree")
          ) ?? []
        }
        result={canopyGviResult}
        visible={debugToggles.gviProjection}
      />
      {!isViewerReady && (
        <div className="loading-overlay">
          {viewerInitError ? (
            <div className="loading-overlay__error">
              <div className="loading-overlay__error-title">Couldn't start the 3D view</div>
              <div className="loading-overlay__error-message">{viewerInitError}</div>
              <div className="loading-overlay__error-hint">
                This usually means the browser's graphics (WebGL) process needs a reset —
                close this tab (or fully restart the browser, not just refresh) and reopen the page.
              </div>
            </div>
          ) : (
            <div className="loading-overlay__logo-wrap">
              <div className="loading-overlay__spinner" />
              <div className="loading-overlay__logo-circle">
                <img className="loading-overlay__logo-full" src="/gvi-logo.png" alt="Green View Index — Loading" />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
