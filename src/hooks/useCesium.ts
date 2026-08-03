import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import {
  DEFAULT_LOCATION,
  DEFAULT_VIEW,
  MODEL_BASE_OFFSET_M,
  SITE_MASK_BASE_HALF_DEPTH_M,
  SITE_MASK_BASE_HALF_WIDTH_M,
} from "../utils/constants";
import { BuildingLayer } from "../gis/BuildingLayer";
import { loadTerrain } from "../gis/TerrainLayer";
import { indoorCamera } from "../features/indoor-camera/IndoorCameraController";

// useCesium owns the lifecycle of the Cesium Viewer instance: creation,
// enabling World Terrain + OSM Buildings, and teardown on unmount.

// Real OSM building geometry at the same footprint as our placed custom
// GLB z-fights with it (both meshes at the same spot flicker/swap on top
// depending on view angle). Hide ONLY the real OSM building(s) directly
// under our model — not a whole block's worth of unrelated neighboring
// buildings, which the surrounding street context (and the GVI scan's view
// of what actually blocks a sightline) both depend on staying real 3D
// geometry rather than being flattened.
//
// A previous fixed 200m radius was masking roughly a full city block. A
// later "footprint diagonal as circle radius" version fixed that but
// over-masked in a different way: for a non-square building (this one is
// ~2x longer than it is wide), a circle sized to reach the far CORNER
// overshoots by tens of meters along the SHORT axis — in this dense block
// that reached real neighboring buildings across the street, hiding them
// entirely (revealing bare basemap imagery where their mesh should be).
// This tests the actual rotated footprint rectangle instead, so masking
// only ever extends `SITE_MASK_MARGIN_M` past the building's real edge in
// every direction, not up to a corner-sized radius in every direction.
const SITE_MASK_MARGIN_M = 8;
  
// Nearby OSM Buildings only — beyond this radius, buildings are hidden via
// the tileset style rather than left to render across the whole loaded
// area regardless of how far the camera pulls back or how wide the intro
// orbit's view gets.
const MAX_VISIBLE_RADIUS_M = 1000;

// The loading screen (logo + spinner) stays up at least this long from the
// moment setup() starts, regardless of how fast terrain/buildings actually
// load — a deliberate minimum so the splash reads as an intentional beat
// rather than a flash that's gone before it registers. Measured against
// setupStartedAt, and only ever ADDS wait on top of a fast load. Fixed at
// 3s per explicit request: spinner (3s) -> map -> building, staged and
// fast, rather than blocking longer on trying to make tiles look complete
// before reveal (see the shortened wait timeouts below) — a map that
// visibly sharpens up over the following second or two after appearing is
// normal, expected behavior for basically every mapping app, not a flaw
// worth trading load speed for.
const MIN_SPLASH_MS = 3000;

// Always waited out AFTER the intro orbit starts rotating (not just
// counted toward MIN_SPLASH_MS above), regardless of how much of the
// splash budget setup() already used — see the reveal logic below for why
// a shared single buffer isn't enough on a slow connection. Kept short:
// this is a minimum floor for "orbit has visibly started moving", not a
// wait for the new view's tiles to fully resolve (that's no longer worth
// blocking on — see MIN_SPLASH_MS above).
const ORBIT_WARMUP_MS = 500;

// Render resolution multiplier — 1 preserves current visual quality exactly.
// Optionally tunable via VITE_CESIUM_RESOLUTION_SCALE (e.g. "0.85") without
// a code change, for lower-end devices where a slightly softer render is an
// acceptable trade for GPU headroom. Left unset/1 by default.
const CESIUM_RESOLUTION_SCALE = (() => {
  const raw = import.meta.env.VITE_CESIUM_RESOLUTION_SCALE as string | undefined;
  const parsed = raw ? Number(raw) : 1;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 1;
})();

// Provisional mask params used only for the few hundred ms between the OSM
// Buildings tileset loading and CesiumViewer's live-sync effect applying the
// real building transform — matches App.tsx's INITIAL_BUILDING so there's no
// visible mismatch in that window. Not imported from App.tsx to avoid a
// dependency from this low-level hook back up to the top-level component.
const INITIAL_BUILDING_ROTATION_RAD = Cesium.Math.toRadians(120);
const INITIAL_BUILDING_SCALE = 1.55;

export function maskOsmBuildingsNearSite(
  tileset: Cesium.Cesium3DTileset,
  longitude: number,
  latitude: number,
  rotationRad: number,
  scale: number
): void {
  // Real meters-per-degree, not a flat 111320 for both axes — longitude
  // compresses with cos(latitude), so treating it like latitude previously
  // over-estimated east-west distance and over-masked in that direction.
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(Cesium.Math.toRadians(latitude));

  const halfWidthM = SITE_MASK_BASE_HALF_WIDTH_M * scale + SITE_MASK_MARGIN_M;
  const halfDepthM = SITE_MASK_BASE_HALF_DEPTH_M * scale + SITE_MASK_MARGIN_M;
  const cosR = Math.cos(rotationRad);
  const sinR = Math.sin(rotationRad);
  const originEastM = longitude * metersPerDegLon;
  const originNorthM = latitude * metersPerDegLat;

  // World east/north offset of the feature from the building's origin.
  const dx = `(\${feature['cesium#longitude']} * ${metersPerDegLon.toFixed(2)} - ${originEastM.toFixed(3)})`;
  const dy = `(\${feature['cesium#latitude']} * ${metersPerDegLat.toFixed(2)} - ${originNorthM.toFixed(3)})`;
  // Straight-line distance from the site, unrotated — used only for the
  // citywide radius cutoff below, so rotation doesn't matter here.
  const radialDistance = `sqrt((${dx}) * (${dx}) + (${dy}) * (${dy}))`;
  // Rotate that offset into the building's own local axes (inverse of the
  // rotation used to place the model — see services/camera.ts's
  // facadeLocalOffset for the forward version of this same rotation).
  const localX = `(${dx} * ${cosR.toFixed(6)} + ${dy} * ${sinR.toFixed(6)})`;
  const localY = `(-${dx} * ${sinR.toFixed(6)} + ${dy} * ${cosR.toFixed(6)})`;

  tileset.style = new Cesium.Cesium3DTileStyle({
    show: {
      conditions: [
        // Buildings this style's condition list never even considers
        // (beyond MAX_VISIBLE_RADIUS_M) still get requested/streamed by
        // Cesium as tiles when they're in the camera frustum — this only
        // controls which already-loaded features get drawn, so it caps
        // rendered clutter/draw cost around the site, not network traffic.
        [`${radialDistance} > ${MAX_VISIBLE_RADIUS_M.toFixed(1)}`, "false"],
        [
          `abs(${localX}) < ${halfWidthM.toFixed(2)} && abs(${localY}) < ${halfDepthM.toFixed(2)}`,
          "false",
        ],
        ["true", "true"],
      ],
    },
    // OSM Buildings ships with a baked olive/khaki vertex color — override
    // it to a clean off-white so nearby buildings read as clean massing
    // instead. Not pure #FFFFFF: combined with the flat UNLIT shading
    // below (no shadow/highlight variation at all), pure white buildings
    // were blowing out to the same brightness as the sky/water background
    // and each other, losing all visual separation. A slightly darker
    // off-white keeps the "clean white massing" look while giving enough
    // contrast to actually see building silhouettes against the
    // background and against each other.
    color: "color('#A8A8A8')",
  });
  // Cesium3DTileset defaults colorBlendMode to HIGHLIGHT, which multiplies
  // the style color into the tile's existing (olive) color rather than
  // replacing it — white * olive is still olive, which is why the style
  // color alone had no visible effect. REPLACE makes the style color the
  // final color.
  tileset.colorBlendMode = Cesium.Cesium3DTileColorBlendMode.REPLACE;
  // PBR shading (the previous approach here) lights each face by its angle
  // to the sun — N·L — which is exactly why east/west walls (more
  // perpendicular to the sun) read visibly brighter than north/south walls:
  // that's real directional lighting working as intended, not a bug. Since
  // the goal is the SAME white on every face regardless of orientation,
  // switch the lighting model to UNLIT: under UNLIT, material.diffuse (the
  // white from the style color above) becomes the final pixel color
  // directly, with no light-direction, ambient, occlusion, or specular term
  // involved at all — every face renders identically regardless of which
  // way it faces the sun. This also makes the earlier PBR-only fixes
  // (neutral ambient color, forcing occlusion/specular to cancel dark
  // seams) unnecessary, since none of that lighting math runs anymore.
  tileset.customShader = new Cesium.CustomShader({
    lightingModel: Cesium.LightingModel.UNLIT,
  });
}

// Cesium's default maximumScreenSpaceError (16) is tuned for smooth panning
// over a whole city, not a tight top-down shot right over one block — at
// that range it keeps a coarser LOD in place, which can read as "some
// buildings not shown". A lower value requests finer tiles sooner, BUT this
// app has no VITE_CESIUM_ION_TOKEN set (see .env.example), so every tile
// request rides Cesium's shared, rate-limited demo token — dropping this
// too low (previously 4) fires far more requests at that same limit and
// makes MORE tiles fail/drop, the opposite of the intent. 8 is a middle
// ground; get a free ion token and set VITE_CESIUM_ION_TOKEN to remove the
// rate limit entirely and it's then safe to lower this further.
function tuneOsmBuildingsLod(tileset: Cesium.Cesium3DTileset): void {
  tileset.maximumScreenSpaceError = 8;
  tileset.dynamicScreenSpaceError = true;
  tileset.skipLevelOfDetail = true;
  tileset.cacheBytes = 1024 * 1024 * 1024;
  tileset.maximumCacheOverflowBytes = 1024 * 1024 * 1024;
}

// createOsmBuildingsAsync/Cesium3DTileset.fromUrl only resolve once the
// tileset's root metadata has loaded — the actual visible tiles for the
// current camera view are still streaming in afterward.
// tileset.initialTilesLoaded fires exactly once all tiles needed for the
// current view have actually finished streaming — a genuinely nice signal
// when it arrives quickly, but not worth blocking reveal on for long: this
// app rides Cesium's shared, rate-limited demo ion token (see the token
// comment above), where tile loading can take several real seconds, and a
// fast, staged reveal (spinner -> map -> building) matters more than
// waiting for every tile to be perfect first. 1500ms gives fast/cached
// loads a chance to actually finish and avoid a visible pop, without
// meaningfully delaying reveal on a slow connection — past that, the map
// just keeps sharpening up live after reveal, same as most map apps.
function waitForTilesetInitialTilesLoaded(
  tileset: Cesium.Cesium3DTileset,
  timeoutMs = 1500
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      removeListener();
      clearTimeout(timeoutId);
      resolve();
    };
    // Already fully loaded by the time we started listening (e.g. served
    // from cache) — initialTilesLoaded would never fire again to tell us.
    if (tileset.tilesLoaded) {
      finish();
      return;
    }
    const removeListener = tileset.initialTilesLoaded.addEventListener(finish);
    const timeoutId = setTimeout(finish, timeoutMs);
  });
}

// The building tileset finishing its initial load (above) doesn't cover
// the terrain/imagery underneath it. Globe has no "loaded" event, only a
// tilesLoaded boolean (true once its terrain+imagery load queue is empty
// for the current view), so this polls it once per rendered frame via
// postRender rather than an event listener. Same short timeout reasoning
// as waitForTilesetInitialTilesLoaded above — fast reveal over waiting for
// a perfect first frame.
function waitForGlobeTilesLoaded(
  viewer: Cesium.Viewer,
  timeoutMs = 1500
): Promise<void> {
  return new Promise((resolve) => {
    const globe = viewer.scene.globe;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      removeListener();
      clearTimeout(timeoutId);
      resolve();
    };
    if (globe.tilesLoaded) {
      finish();
      return;
    }
    const removeListener = viewer.scene.postRender.addEventListener(() => {
      if (globe.tilesLoaded) finish();
    });
    const timeoutId = setTimeout(finish, timeoutMs);
  });
}

export interface UseCesiumResult {
  containerRef: React.RefObject<HTMLDivElement>;
  viewer: Cesium.Viewer | null;
  isReady: boolean;
  osmBuildingsRef: React.MutableRefObject<Cesium.Cesium3DTileset | null>;
  /** Set if Cesium.Viewer construction itself throws (e.g. WebGL context creation failing at the browser/GPU level) — see the try/catch around `new Cesium.Viewer` below. */
  initError: string | null;
}

export function useCesium(): UseCesiumResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const osmBuildingsRef = useRef<Cesium.Cesium3DTileset | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;

    // Optional: set VITE_CESIUM_ION_TOKEN in .env to use your own free ion
    // account token instead of Cesium's shared demo token (which works but
    // shows a "using the default access token" watermark and is rate-limited).
    const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined;
    if (ionToken) {
      Cesium.Ion.defaultAccessToken = ionToken;
    }

    // Cesium's credit/attribution display is required by ion's terms of
    // service — it can't be deleted outright, but it can be rendered into an
    // off-screen container instead of the visible widget UI.
    const hiddenCreditContainer = document.createElement("div");
    hiddenCreditContainer.style.display = "none";
    document.body.appendChild(hiddenCreditContainer);

    let viewer: Cesium.Viewer;
    try {
      viewer = new Cesium.Viewer(containerRef.current, {
        timeline: false,
        animation: false,
        baseLayerPicker: true,
        geocoder: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        homeButton: true,
        fullscreenButton: false,
        creditContainer: hiddenCreditContainer,
        // Needed for scene.canvas.toDataURL() to work (BalconyGviView's
        // captured-preview snapshot) — WebGL clears the drawing buffer after
        // each frame otherwise, so a screenshot taken any time after render
        // would come back blank.
        contextOptions: { webgl: { preserveDrawingBuffer: true } },
      });
    } catch (error) {
      // WebGL context creation can fail at the browser/GPU-process level —
      // observed in practice after many rapid dev-mode hot-reloads pile up
      // WebGL contexts until the browser's GPU process gets into a bad
      // state ("The browser supports WebGL, but initialization failed").
      // Uncaught, this throws synchronously out of the effect and crashes
      // the whole React tree to a blank page with no on-screen explanation
      // — catching it lets the app show a real message (and suggest a
      // fix: closing/reopening the browser resets the GPU process) instead.
      console.error("[useCesium] Failed to construct Cesium.Viewer:", error);
      hiddenCreditContainer.remove();
      setInitError(
        error instanceof Error
          ? error.message
          : "Failed to initialize the 3D view (WebGL context creation failed)."
      );
      return;
    }

    viewerRef.current = viewer;

    // --- Perf: only render when something actually changed, instead of
    // every frame regardless of whether the scene is static. Cesium
    // already auto-detects and requests a render for the vast majority of
    // real changes (camera moves/flights, primitives/entities added or
    // removed, tiles finishing load, imagery/terrain updates) — this is
    // safe by default. The few code paths that mutate rendered state in
    // ways Cesium's own change-detection doesn't see (raw per-instance
    // geometry attribute writes, and anything reading canvas pixels
    // synchronously right after a change) call viewer.scene.requestRender()
    // or viewer.scene.render() explicitly themselves — see TreeRenderer.ts's
    // hover highlight and useCapturedView.ts's capture path.
    viewer.scene.requestRenderMode = true;
    viewer.scene.maximumRenderTimeChange = Infinity;

    // Matches Cesium's own defaults (all off) — set explicitly so behavior
    // doesn't silently change on a future Cesium upgrade, and so it's
    // documented that these were deliberately left off rather than
    // overlooked. No visual change versus current behavior.
    viewer.shadows = false;
    viewer.scene.shadowMap.enabled = false;
    viewer.scene.highDynamicRange = false;
    viewer.scene.globe.enableLighting = false;

    // Configurable render resolution — CESIUM_RESOLUTION_SCALE below
    // defaults to 1 (no change from current behavior). Lowering it (e.g.
    // 0.85-0.9) trades a small amount of sharpness for meaningfully less
    // GPU fill-rate work on constrained devices; left at 1 here so nothing
    // about current visual quality changes unless deliberately tuned.
    viewer.resolutionScale = CESIUM_RESOLUTION_SCALE;

    // Cesium's default render loop treats ANY single-frame render error as
    // fatal: it permanently sets useDefaultRenderLoop = false and injects a
    // ".cesium-widget-errorPanel" element (confirmed by reading Cesium's
    // own CesiumWidget.js source — the try/catch around widget.resize()/
    // widget.render() has no retry, just a hard stop), including for
    // transient races like the container briefly reporting zero width
    // during a layout reflow (e.g. right as the loading overlay unmounts,
    // or during a Vite HMR remount mid-session) — a one-frame blip that
    // would otherwise be invisible turns into a permanently dead scene. A
    // MutationObserver watches for that specific panel appearing and
    // retries the render loop a bounded number of times; by the very next
    // frame the container almost always has a real size again, so this
    // typically recovers invisibly instead of leaving the app stuck.
    let renderRecoveryAttempts = 0;
    const MAX_RENDER_RECOVERY_ATTEMPTS = 5;
    const errorPanelObserver = new MutationObserver(() => {
      const errorPanel = viewer.container.querySelector<HTMLElement>(
        ".cesium-widget-errorPanel"
      );
      if (!errorPanel) return;
      if (renderRecoveryAttempts >= MAX_RENDER_RECOVERY_ATTEMPTS) {
        // eslint-disable-next-line no-console
        console.error(
          "[useCesium] Render loop stopped and exceeded max auto-recovery attempts; leaving Cesium's error panel visible."
        );
        return;
      }
      renderRecoveryAttempts++;
      errorPanel.remove();
      requestAnimationFrame(() => {
        if (viewer.isDestroyed()) return;
        viewer.useDefaultRenderLoop = true;
        // Under requestRenderMode, resuming the loop alone doesn't
        // guarantee a "changed" flag is set — force one real frame so
        // recovery doesn't leave the canvas showing the stale pre-error
        // content until something else happens to trigger a render.
        viewer.scene.requestRender();
      });
    });
    errorPanelObserver.observe(viewer.container, { childList: true });

    // Default the base layer picker to "Google Maps Satellite with Labels"
    // instead of Cesium's own out-of-the-box default (Bing Maps Aerial) —
    // matches what's selected in the imagery picker UI. Looked up by name
    // from the picker's own provider list rather than hand-constructing an
    // IonImageryProvider directly, so this stays in sync with whatever ion
    // asset id Cesium's default list points at.
    const googleSatelliteWithLabels =
      viewer.baseLayerPicker.viewModel.imageryProviderViewModels.find(
        (providerViewModel) =>
          providerViewModel.name === "Google Maps Satellite with Labels"
      );
    if (googleSatelliteWithLabels) {
      viewer.baseLayerPicker.viewModel.selectedImagery = googleSatelliteWithLabels;
    }

    // A generous bounding sphere around the whole building (center raised to
    // roughly its vertical midpoint, radius large enough to comfortably
    // contain it) — used instead of a hand-picked absolute camera position
    // so the building is GUARANTEED centered on screen via
    // flyToBoundingSphere, regardless of the browser window's aspect ratio.
    // The previous fixed destination/orientation only looked centered at
    // the one aspect ratio it happened to be tuned on.
    const buildingCenter = Cesium.Cartesian3.fromDegrees(
      DEFAULT_LOCATION.longitude,
      DEFAULT_LOCATION.latitude,
      DEFAULT_LOCATION.height + MODEL_BASE_OFFSET_M * INITIAL_BUILDING_SCALE + 100
    );
    const buildingBoundingSphere = new Cesium.BoundingSphere(buildingCenter, 140);
    const DEFAULT_VIEW_RANGE_M = 400;

    function flyToDefaultView(durationSeconds: number): void {
      viewer.camera.flyToBoundingSphere(buildingBoundingSphere, {
        offset: new Cesium.HeadingPitchRange(
          Cesium.Math.toRadians(DEFAULT_VIEW.headingDeg),
          Cesium.Math.toRadians(DEFAULT_VIEW.pitchDeg),
          DEFAULT_VIEW_RANGE_M
        ),
        duration: durationSeconds,
      });
    }

    // One full revolution around the building, landing exactly on
    // DEFAULT_VIEW's own heading/pitch/distance — a cheap "reveal" for the
    // first load that doesn't require a second, separate flyTo at the end
    // since the orbit's own end pose IS the default view. Cancels early
    // (releasing the camera back to normal control immediately) the instant
    // the user tries to interact, so it never fights a real drag/scroll.
    function runIntroOrbit(): void {
      // Same center/range flyToDefaultView uses, so the orbit's end pose is
      // pixel-identical to the resting default view — not a separately
      // hand-picked position that could drift out of sync with it.
      const center = buildingCenter;
      const range = DEFAULT_VIEW_RANGE_M;
      const pitch = Cesium.Math.toRadians(DEFAULT_VIEW.pitchDeg);
      const endHeading = Cesium.Math.toRadians(DEFAULT_VIEW.headingDeg);
      const startHeading = endHeading - Cesium.Math.TWO_PI;

      const durationMs = 6000;
      const startTime = performance.now();
      const canvas = viewer.scene.canvas;
      let stopped = false;

      function stopEarly() {
        stopped = true;
      }
      canvas.addEventListener("pointerdown", stopEarly, { once: true });
      canvas.addEventListener("wheel", stopEarly, { once: true });

      function frame(now: number) {
        if (viewer.isDestroyed()) return;
        if (stopped) {
          viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
          return;
        }
        const t = Math.min(1, (now - startTime) / durationMs);
        const eased = 1 - Math.pow(1 - t, 3); // ease-out — settles gently instead of stopping abruptly
        const heading = Cesium.Math.lerp(startHeading, endHeading, eased);
        viewer.camera.lookAt(center, new Cesium.HeadingPitchRange(heading, pitch, range));
        // Safety net under requestRenderMode — camera.lookAt should already
        // be auto-detected as a camera change, but this custom rAF loop
        // (not Cesium's own flight/controller code) is exactly the kind of
        // path worth not trusting blindly for something as visible as the
        // very first thing a user sees.
        viewer.scene.requestRender();
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
          canvas.removeEventListener("pointerdown", stopEarly);
          canvas.removeEventListener("wheel", stopEarly);
        }
      }
      requestAnimationFrame(frame);
    }

    // The Home button's built-in action flies out to a whole-Earth view —
    // override it to come back to the building's own default shot instead.
    viewer.homeButton.viewModel.command.beforeExecute.addEventListener((commandInfo) => {
      commandInfo.cancel = true;
      // Leaving indoor mode (if we were in it) BEFORE the fly-out restores
      // the default Cesium controller so the flight itself isn't clamped by
      // indoor mode's disabled zoom/translate.
      indoorCamera.exit(viewer);
      flyToDefaultView(1.5);
    });

    // Set the default shot immediately, before terrain/buildings even start
    // loading — otherwise Cesium's out-of-the-box whole-Earth camera view is
    // visible (however briefly) until the async setup below reaches its own
    // flyTo at the very end.
    flyToDefaultView(0);

    async function setup() {
      // Measured against MIN_SPLASH_MS below — the loading screen stays up
      // at least this long from the moment setup actually starts, even if
      // terrain/buildings finish loading well before that, so it reads as
      // a deliberate, smooth splash instead of a flash that's gone before
      // anyone registers it.
      const setupStartedAt = performance.now();

      // Tracked across whichever branch below actually creates the OSM
      // Buildings tileset, so it can be awaited once at the end (see
      // waitForTilesetInitialTilesLoaded) before the loading screen comes
      // down and the intro orbit starts — without this, the reveal timing
      // has no reference to the one tileset actually on screen.
      let loadedOsmBuildings: Cesium.Cesium3DTileset | undefined;

      try {
        const terrainUrl = import.meta.env.VITE_TERRAIN_URL as string | undefined;
        if (terrainUrl) {
          await loadTerrain(viewer, terrainUrl);
        } else {
          viewer.terrainProvider = await Cesium.createWorldTerrainAsync();
        }
        // Without this, entities/models always render in front of terrain
        // regardless of actual depth, which reads as the model "sliding"
        // relative to the ground as the camera angle changes.
        viewer.scene.globe.depthTestAgainstTerrain = true;

        // Switching balcony floors (or an Auto Navigation run) jumps the
        // camera to a very different height/angle each time, which needs
        // different terrain/imagery tile detail than the previous floor —
        // Cesium's default terrain cache (100 tiles) evicts tiles for a
        // view as soon as they're not needed, so returning to a floor
        // already visited re-streams its ground tiles from scratch instead
        // of reusing what was already loaded, visible as the "map reloads"
        // pop the trees (built once as persistent Primitives, not
        // re-streamed at all regardless of camera position) don't have.
        // A much larger cache keeps recently-seen floors' tiles resident;
        // preloadAncestors/preloadSiblings fill in newly-exposed area
        // around whatever's already loaded instead of only the exact
        // tiles the current view strictly needs.
        viewer.scene.globe.tileCacheSize = 1000;
        viewer.scene.globe.preloadAncestors = true;
        viewer.scene.globe.preloadSiblings = true;

        const lidarApiUrl = import.meta.env.VITE_LIDAR_API_URL as string | undefined;
        if (lidarApiUrl) {
          const buildingLayer = new BuildingLayer(viewer);
          try {
            await buildingLayer.load(`${lidarApiUrl.replace(/\/$/, "")}/buildings`);
          } catch (error) {
            // Building footprints are optional; retain the city context when
            // this LiDAR run was exported without them.
            console.warn("Processed building layer unavailable; using OSM buildings", error);
            // Show OSM Buildings' outlines (from the glTF CESIUM_primitive_outline
            // extension) and style them white instead of the default black.
            const osmBuildings = await Cesium.createOsmBuildingsAsync({
              showOutline: true,
            });
            osmBuildings.outlineColor = Cesium.Color.WHITE;
            tuneOsmBuildingsLod(osmBuildings);
            maskOsmBuildingsNearSite(
              osmBuildings,
              DEFAULT_LOCATION.longitude,
              DEFAULT_LOCATION.latitude,
              INITIAL_BUILDING_ROTATION_RAD,
              INITIAL_BUILDING_SCALE
            );
            if (!cancelled) {
              viewer.scene.primitives.add(osmBuildings);
              osmBuildingsRef.current = osmBuildings;
              loadedOsmBuildings = osmBuildings;
            }
          }
        } else {
          const osmBuildings = await Cesium.createOsmBuildingsAsync({
            showOutline: true,
          });
          osmBuildings.outlineColor = Cesium.Color.WHITE;
          tuneOsmBuildingsLod(osmBuildings);
          maskOsmBuildingsNearSite(
            osmBuildings,
            DEFAULT_LOCATION.longitude,
            DEFAULT_LOCATION.latitude,
            INITIAL_BUILDING_ROTATION_RAD,
            INITIAL_BUILDING_SCALE
          );
          if (!cancelled) {
            viewer.scene.primitives.add(osmBuildings);
            osmBuildingsRef.current = osmBuildings;
            loadedOsmBuildings = osmBuildings;
          }
        }
        const tilesetUrl = import.meta.env.VITE_LIDAR_3D_TILES_URL as
          | string
          | undefined;
        if (tilesetUrl) {
          const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetUrl, {
            maximumScreenSpaceError: 16,
            cullWithChildrenBounds: true,
            skipLevelOfDetail: true,
          });
          if (!cancelled) viewer.scene.primitives.add(tileset);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("Failed to initialize Cesium terrain/buildings:", err);
      }

      if (cancelled) return;

      // Wait for both the buildings AND the ground terrain/imagery actually
      // on screen (at the static starting pose) to finish streaming in.
      await Promise.all([
        loadedOsmBuildings
          ? waitForTilesetInitialTilesLoaded(loadedOsmBuildings)
          : Promise.resolve(),
        waitForGlobeTilesLoaded(viewer),
      ]);

      if (cancelled) return;

      // Start the orbit now, still BEHIND the loading screen (isReady is
      // still false here — the overlay sits at z-index 200 above the
      // canvas and isn't pointer-events:none, so it also blocks the
      // pointerdown/wheel listeners runIntroOrbit sets up to cancel early,
      // meaning no user interaction can reach the canvas to prematurely
      // cancel it during this hidden warm-up either). Starting it as soon
      // as tiles are ready — rather than only right before reveal — means
      // that by the time reveal happens, the building is already visibly
      // mid-rotation, not just starting from a standstill.
      runIntroOrbit();
      const orbitStartedAt = performance.now();

      // Two independent floors, both measured from different starting
      // points, so the wait is whichever needs MORE time left:
      //  - MIN_SPLASH_MS since setup() started: the splash reads as
      //    deliberate rather than a flash on a fast connection.
      //  - ORBIT_WARMUP_MS since the orbit itself started: the waits above
      //    only cover tiles for the STATIC starting camera pose — the
      //    moment the orbit starts changing heading, each new angle needs
      //    its own tiles that were never pre-fetched. Without a real floor
      //    HERE specifically (not just MIN_SPLASH_MS), a slow network that
      //    already ate the whole splash budget before even reaching this
      //    line would reveal with ZERO orbit warm-up — this is exactly
      //    what happened when this used to be one shared 250ms buffer:
      //    on a slow connection the splash floor was already exceeded, so
      //    the 250ms warm-up effectively became 0, and reveal showed a
      //    blurry unrotated-view frame instead of an already-rotating,
      //    already-loaded building.
      const untilSplashFloor = MIN_SPLASH_MS - (performance.now() - setupStartedAt);
      const untilOrbitWarmup = ORBIT_WARMUP_MS - (performance.now() - orbitStartedAt);
      const remainingMs = Math.max(0, untilSplashFloor, untilOrbitWarmup);
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }

      if (cancelled) return;

      setIsReady(true);
      forceRender((n) => n + 1);
    }

    setup();

    return () => {
      cancelled = true;
      errorPanelObserver.disconnect();
      if (!viewer.isDestroyed()) {
        viewer.destroy();
      }
      viewerRef.current = null;
      hiddenCreditContainer.remove();
    };
  }, []);

  return { containerRef, viewer: viewerRef.current, isReady, osmBuildingsRef, initError };
}
