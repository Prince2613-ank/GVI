import { useCallback, useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import { BuildingTransform } from "../../services/camera";
import { computeOutwardHeadingRad } from "../../utils/cameraUtils";
import { indoorCamera } from "../indoor-camera/IndoorCameraController";
import { FLOOR_HEIGHT_M } from "../../utils/constants";
import {
  BALCONIES_PER_SIDE,
  BALCONY_SIDES,
  BalconySide,
  BalconyViewpointCollection,
  BalconyViewpointFeature,
  TOTAL_BALCONY_FLOORS,
} from "./BalconyTypes";
import { resolveBalconyFeature } from "./BalconyFloorGenerator";
import { flyToBalcony } from "./BalconyFlyTo";
import { useCapturedView } from "./useCapturedView";
import { computeGVIFromDataUrl, GVIResult } from "../../services/gvi";
import { fetchViewpoints, manualCapture, resetSlots, RemoteViewpoint } from "./balconyGenerationApi";
import { ManualVegetationCollection } from "../manual-vegetation/types/ManualVegetationTypes";
import { listManualVegetationPolygons } from "../manual-vegetation/storage/VegetationStorage";
import "./BalconyViewpointNavigator.css";

interface BalconyViewpointNavigatorProps {
  viewer: Cesium.Viewer | null;
  building: BuildingTransform;
  collection: BalconyViewpointCollection;
  floor: number;
  side: BalconySide;
  balcony: number;
  onFloorChange: (floor: number) => void;
  onSideChange: (side: BalconySide) => void;
  onBalconyChange: (balcony: number) => void;
  /** Persists a regenerated preview image (or any other feature update) back into the shared collection + localStorage. */
  onPersistCollection: (next: BalconyViewpointCollection) => void;
  onAnalyzeVegetation: () => Promise<void>;
  isViewerReady: boolean;
  vegetationErrorMessage: string | null;
  manualVegetationCollection: ManualVegetationCollection;
}

/**
 * The everyday, non-debug way to look through any flat's balcony: pick a
 * floor, side and flat number and it flies straight there. Only Floor 1
 * needs to have been captured for a given side/flat — every floor above it
 * reuses that exact lon/lat and steps the height up, so all 10 floors work
 * without having to capture each one by hand.
 */
export function BalconyViewpointNavigator({
  viewer,
  building,
  collection,
  floor,
  side,
  balcony,
  onFloorChange,
  onSideChange,
  onBalconyChange,
  onPersistCollection,
  onAnalyzeVegetation,
  isViewerReady,
  vegetationErrorMessage,
  manualVegetationCollection,
}: BalconyViewpointNavigatorProps) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [gallerySearch, setGallerySearch] = useState("");

  // Cinematic "show the whole building" auto-tour: visits every saved/
  // derived balcony viewpoint in sequence with smooth flights, no mouse
  // needed — a demo/pitch opener. tourCancelledRef (not just isTouring
  // state) is what the running async loop actually checks each step, since
  // a ref read inside an in-flight await always sees the latest value;
  // state would be stale-closed over the loop's original render.
  const [isTouring, setIsTouring] = useState(false);
  const [isTourPaused, setIsTourPaused] = useState(false);
  // Auto Navigation now lives entirely behind its own navbar icon (see
  // auto-nav-toggle below) instead of a button + inline picker inside the
  // Balcony Viewpoints panel body — this is that icon's open/closed state,
  // and doubles as the floor-picker's visibility (closed automatically once
  // a tour actually starts, same as the old inline picker used to).
  const [showAutoNavModal, setShowAutoNavModal] = useState(false);
  // Which floor(s) the next tour run covers — chosen independently of
  // direction. "all" walks every floor 1-10; a specific number restricts
  // the whole tour (all requested directions) to just that one floor.
  const [tourFloorScope, setTourFloorScope] = useState<number | "all">("all");
  const [tourProgress, setTourProgress] = useState({ current: 0, total: 0 });
  const [currentTourStop, setCurrentTourStop] = useState<{
    side: BalconySide;
    balcony: number;
    floor: number;
    longitude: number;
    latitude: number;
    height: number;
    headingDeg: number;
  } | null>(null);
  const [showWindowDetails, setShowWindowDetails] = useState(true);
  // Independent close for the Analyse GVI card — closing it shouldn't also
  // close Window Details, and vice versa.
  const [showGviPanel, setShowGviPanel] = useState(false);
  const tourCancelledRef = useRef(false);
  // Read inside the running loop's await chain (a ref, not state — state
  // reads inside an in-flight async function see whatever value existed
  // when the closure was created, not later updates from a click).
  const tourPausedRef = useRef(false);
  const TOUR_DIRECTION_ORDER: BalconySide[] = ["North", "East", "South", "West"];

  // Attached to whichever Saved Views card is currently active (see
  // isActive below) — during an Auto Navigation run, side/balcony/floor
  // change on every stop (handleStartTour's onSideChange/onBalconyChange/
  // onFloorChange calls), so this scrolls the list to follow along
  // automatically instead of leaving the user to manually scroll to find
  // which thumbnail matches the live view.
  const activeGalleryCardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!isTouring) return;
    activeGalleryCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [isTouring, side, balcony, floor]);

  // Ranks every saved/derived window across every floor by GVI score, so a
  // real-estate client can immediately see which units have the greenest
  // (or greyest) view instead of having to check each one by hand.
  interface GviScanResult {
    floor: number;
    side: BalconySide;
    balcony: number;
    gviScore: number;
    previewImage: string;
    feature: BalconyViewpointFeature;
  }
  const [isCalculatingGvi, setIsCalculatingGvi] = useState(false);
  const [gviScanProgress, setGviScanProgress] = useState({ current: 0, total: 0 });
  const [gviScanResults, setGviScanResults] = useState<GviScanResult[]>([]);
  const [gviScanSavedAt, setGviScanSavedAt] = useState<number | null>(null);
  // Full-screen leaderboard opened from a navbar icon — shows every scanned
  // window at once (not just the small in-panel preview list), for a client
  // presentation moment rather than day-to-day navigation.
  const [showLeaderboardModal, setShowLeaderboardModal] = useState(false);
  const [deleteTopCount, setDeleteTopCount] = useState(18);
  const gviScanCancelledRef = useRef(false);

  // Persists the ranking so re-opening it (or reloading the page) doesn't
  // require re-scanning every window all over again — the scan only re-runs
  // when the user explicitly asks for a fresh one. The backend (Postgres,
  // via manualCapture below) is the durable source of truth so this survives
  // forever across reloads/machines; localStorage is only a same-browser
  // fallback for when the backend isn't reachable (e.g. running the
  // frontend alone without `cesium-demo/backend` up).
  const GVI_SCAN_CACHE_KEY = "gvi-scan-results-cache:v1";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const viewpoints = await fetchViewpoints();
        if (cancelled) return;
        const results: GviScanResult[] = viewpoints
          .filter(
            (v): v is RemoteViewpoint & { gvi: number; previewImageUrl: string; floorNumber: number } =>
              v.gvi !== null && v.previewImageUrl !== null && v.floorNumber !== null
          )
          .map((v) => ({
            floor: v.floorNumber,
            side: v.direction,
            balcony: v.flatNumber,
            gviScore: v.gvi,
            previewImage: v.previewImageUrl,
            feature: {
              type: "Feature" as const,
              properties: {
                id: v.id,
                floor: v.floorNumber,
                side: v.direction,
                balcony: v.flatNumber,
                type: "balcony_viewpoint" as const,
              },
              geometry: {
                type: "Point" as const,
                coordinates: [v.camera.longitude, v.camera.latitude, v.camera.height] as [number, number, number],
              },
            },
          }))
          .sort((a, b) => b.gviScore - a.gviScore);
        if (results.length > 0) {
          setGviScanResults(results);
          setGviScanSavedAt(Date.now());
          return;
        }
      } catch {
        // Backend unreachable — fall through to the local cache below.
      }
      try {
        const raw = localStorage.getItem(GVI_SCAN_CACHE_KEY);
        if (!raw || cancelled) return;
        const cached: { savedAt: number; results: GviScanResult[] } = JSON.parse(raw);
        setGviScanResults(cached.results);
        setGviScanSavedAt(cached.savedAt);
      } catch {
        // Corrupt/unavailable cache — just behave as if nothing was saved.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function saveGviScanResults(results: GviScanResult[]): void {
    const savedAt = Date.now();
    setGviScanSavedAt(savedAt);
    try {
      localStorage.setItem(GVI_SCAN_CACHE_KEY, JSON.stringify({ savedAt, results }));
    } catch {
      // Storage full/unavailable — persistence is a pure optimization, safe to skip.
    }
  }

  // Backend-generated previews/GVI (see GenerationControlPanel + cesium-demo/backend)
  // take priority over the local-only capture/GVI data below whenever a
  // matching remote viewpoint exists for the current floor.
  const [remoteViewpoints, setRemoteViewpoints] = useState<RemoteViewpoint[]>([]);
  const refreshRemoteViewpoints = useCallback(() => {
    return fetchViewpoints()
      .then((viewpoints) => {
        setRemoteViewpoints(viewpoints.filter((v) => v.floorNumber === floor));
      })
      .catch(() => {
        // Backend not running / unreachable — gallery just falls back to local-only data.
        setRemoteViewpoints([]);
      });
  }, [floor]);

  useEffect(() => {
    let cancelled = false;
    function refresh() {
      if (!cancelled) void refreshRemoteViewpoints();
    }
    refresh();
    // Polls while generation may still be running elsewhere (GenerationControlPanel) so
    // freshly-completed previews/GVI show up here without needing a manual reload.
    const interval = setInterval(refresh, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [floor]);
  const remoteByKey = new Map(remoteViewpoints.map((v) => [`${v.direction}-${v.flatNumber}`, v]));

  // Freeform "capture whatever's on screen" workflow — works from ANY
  // camera position, entirely independent of the floor/side/flat selection
  // above. Analyze GVI (below) always scores exactly this captured image,
  // never the live Cesium frame, so the result can never drift from what
  // was actually captured.
  const { capturedView, captureCurrentView } = useCapturedView();
  const [capturedImageResult, setCapturedImageResult] = useState<GVIResult | null>(null);
  const [isDebugPanelOpen, setIsDebugPanelOpen] = useState(false);
  const [gviPipelineStage, setGviPipelineStage] = useState<
    "idle" | "vegetation" | "capturing" | "analyzing"
  >("idle");
  // Nearby vegetation is scoped to the building's location, not to whichever
  // balcony/floor is currently selected — once it's been analyzed here,
  // re-running it on every subsequent "Analyse GVI" click would just redo
  // the same fetch + render for no new data. Flips true after the first
  // successful run and stays true for the rest of the session.
  const [hasAnalyzedVegetation, setHasAnalyzedVegetation] = useState(false);

  /**
   * The single "Analyse GVI" button: runs the three previously-separate
   * steps (Analyze Nearby Vegetation, Capture Current View, Analyze GVI)
   * back-to-back in that order, so the user never has to click through them
   * one at a time — except the first step is skipped after it's already
   * succeeded once (see hasAnalyzedVegetation above). Each step only starts
   * once the previous one has fully finished — captureCurrentView's return
   * value is used directly (rather than reading the `capturedView` state
   * right after calling it) since React state updates aren't synchronous
   * and the freshly-captured image is needed immediately for the analysis
   * step.
   */
  async function handleAnalyzeGvi() {
    try {
      if (!hasAnalyzedVegetation) {
        setGviPipelineStage("vegetation");
        await onAnalyzeVegetation();
        setHasAnalyzedVegetation(true);
      }

      setGviPipelineStage("capturing");
      const polygons = listManualVegetationPolygons(manualVegetationCollection);
      const captured = captureCurrentView(viewer, polygons);
      setCapturedImageResult(null);
      if (!captured) return;

      setGviPipelineStage("analyzing");
      const result = await computeGVIFromDataUrl(captured.image, {
        generateMask: true,
        manualVegetationMask: captured.manualVegetationMask,
      });
      setCapturedImageResult(result);
    } finally {
      setGviPipelineStage("idle");
    }
  }

  const gviPipelineLabel =
    gviPipelineStage === "vegetation"
      ? "Analyzing nearby vegetation…"
      : gviPipelineStage === "capturing"
        ? "Capturing view…"
        : gviPipelineStage === "analyzing"
          ? "Analyzing GVI…"
          : "Analyse GVI";

  const floorHeightDeltaM = FLOOR_HEIGHT_M * building.scale;

  // Gallery: every side/flat combo that resolves to a point (saved or
  // derived from that flat's Floor 1 capture) for the currently-selected
  // floor — replaces manual Direction/Flat selection with a browsable list.
  interface GalleryEntry {
    side: BalconySide;
    balcony: number;
    feature: BalconyViewpointFeature;
    isSaved: boolean;
  }
  const galleryEntries: GalleryEntry[] = BALCONY_SIDES.flatMap((s) =>
    Array.from({ length: BALCONIES_PER_SIDE }, (_, i) => i + 1)
      .map((b) => {
        const r = resolveBalconyFeature(collection.features, floor, s, b, floorHeightDeltaM);
        return r ? { side: s, balcony: b, feature: r.feature, isSaved: r.isSaved } : null;
      })
      .filter((entry): entry is GalleryEntry => entry !== null)
  );

  const searchTerm = gallerySearch.trim().toLowerCase();
  const filteredEntries = searchTerm
    ? galleryEntries.filter((entry) =>
        `${entry.side} window ${entry.balcony}`.toLowerCase().includes(searchTerm)
      )
    : galleryEntries;

  // Always North -> East -> South -> West, windows ascending within each —
  // a fixed, predictable walking order instead of shuffling around by
  // capture time, so the gallery always reads the same way the auto-tour
  // itself walks the floor.
  const GALLERY_DIRECTION_ORDER: BalconySide[] = ["North", "East", "South", "West"];
  const sortedEntries = [...filteredEntries].sort((a, b) => {
    const sideDiff = GALLERY_DIRECTION_ORDER.indexOf(a.side) - GALLERY_DIRECTION_ORDER.indexOf(b.side);
    if (sideDiff !== 0) return sideDiff;
    return a.balcony - b.balcony;
  });

  function handleGoToEntry(entry: GalleryEntry) {
    if (!viewer) return;
    tourCancelledRef.current = true; // any manual navigation interrupts a running tour
    tourPausedRef.current = false;
    setIsTourPaused(false);
    setTourProgress({ current: 0, total: 0 });
    // Window Details is auto-tour only — a manual click just flies there
    // without popping that panel. The Analyse GVI card is shared by both
    // flows though, so it still opens here.
    setCurrentTourStop(null);
    setShowWindowDetails(false);
    setShowGviPanel(true);
    onSideChange(entry.side);
    onBalconyChange(entry.balcony);
    const headingRad = computeOutwardHeadingRad(building.rotationRad, entry.side);
    flyToBalcony(viewer, entry.feature, headingRad);
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * A pure straight-line lateral glide between two windows on the SAME
   * facade — no arc, no altitude swoop, just a level slide sideways, which
   * is what actually reads as "walking window to window" rather than a
   * little hop-and-land each time. camera.flyTo (used for bigger jumps
   * between floors/directions below) always raises altitude mid-flight for
   * anything but a trivial distance, which is exactly the "jump" feeling
   * that's wrong for two windows a few meters apart on the same wall.
   */
  function glideBetweenWindows(
    destination: Cesium.Cartesian3,
    headingRad: number,
    durationSeconds: number
  ): Promise<void> {
    if (!viewer) return Promise.resolve();
    const camera = viewer.camera;
    const startPosition = Cesium.Cartesian3.clone(camera.positionWC);
    const startHeading = camera.heading;
    const pitch = Cesium.Math.toRadians(-5);
    const durationMs = durationSeconds * 1000;
    const startTime = performance.now();

    return new Promise((resolve) => {
      function frame(now: number) {
        const t = Math.min(1, (now - startTime) / durationMs);
        const eased = t * (2 - t); // ease-out — settles gently instead of stopping abruptly
        const position = Cesium.Cartesian3.lerp(startPosition, destination, eased, new Cesium.Cartesian3());
        const heading = Cesium.Math.lerp(startHeading, headingRad, eased);
        camera.setView({ destination: position, orientation: { heading, pitch, roll: 0 } });
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  /**
   * Flies to the SAME kind of pose "Go To View" uses (proven correct — it's
   * what the gallery thumbnails show) directly via camera.flyTo, WITHOUT
   * going through flyToBalcony — that function's `complete` callback also
   * triggers indoorCamera.enter(), which would flip on Indoor Camera Mode
   * (locking wheel-zoom, popping the movement overlay) after every single
   * stop of a hands-off cinematic tour. This replicates its exact
   * destination/heading/pitch math, just without that side effect.
   */
  function flyToBalconyPoseOnly(
    entryFeature: GalleryEntry["feature"],
    headingRad: number,
    durationSeconds: number
  ): Promise<void> {
    if (!viewer) return Promise.resolve();
    const [longitude, latitude, height] = entryFeature.geometry.coordinates;
    return new Promise((resolve) => {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
        orientation: { heading: headingRad, pitch: Cesium.Math.toRadians(-5), roll: 0 },
        duration: durationSeconds,
        complete: () => resolve(),
        cancel: () => resolve(),
      });
    });
  }

  /** Polls until resumed or cancelled — Pause just blocks the loop between steps, it never aborts an in-flight glide/flight. */
  async function waitWhilePaused() {
    while (tourPausedRef.current && !tourCancelledRef.current) {
      await wait(150);
    }
  }

  function handlePauseTour() {
    tourPausedRef.current = true;
    setIsTourPaused(true);
  }

  function handleResumeTour() {
    tourPausedRef.current = false;
    setIsTourPaused(false);
  }

  /**
   * Every real, saved/derived balcony viewpoint — direction by direction
   * (North, then East, South, West, or just one if the user picked a single
   * direction), and within each direction every flat (1..3) across every
   * floor (1..10) — each held for a beat before flying to the next.
   * Cancels instantly if handleStopTour or any manual navigation happens
   * mid-flight. A floor/flat/direction combo with nothing captured yet is
   * silently skipped rather than stopping the whole tour.
   */
  async function handleStartTour(
    directionChoice: BalconySide | "all",
    // Overrides tourFloorScope for callers that also just changed it in the
    // same click (e.g. an individual floor button) — React state updates
    // aren't synchronous, so reading tourFloorScope right after calling
    // setTourFloorScope in the same handler would still see the OLD value.
    floorScopeOverride?: number | "all"
  ) {
    if (!viewer || isTouring) return;
    setShowAutoNavModal(false);
    indoorCamera.exit(viewer);
    tourCancelledRef.current = false;
    tourPausedRef.current = false;
    setIsTourPaused(false);
    setIsTouring(true);
    setShowWindowDetails(true);
    setShowGviPanel(true);
    try {
      const floorScope = floorScopeOverride ?? tourFloorScope;
      const directions = directionChoice === "all" ? TOUR_DIRECTION_ORDER : [directionChoice];
      const floors = floorScope === "all"
        ? Array.from({ length: TOTAL_BALCONY_FLOORS }, (_, i) => i + 1)
        : [floorScope];

      // Precompute every stop this run will actually visit (skipping combos
      // with no saved/derived viewpoint) so the progress bar reflects real
      // step counts, not a theoretical floors*directions*windows total that
      // would rarely reach 100%.
      type Stop = { floor: number; side: BalconySide; balcony: number; feature: GalleryEntry["feature"] };
      const stops: Stop[] = [];
      for (const f of floors) {
        for (const side of directions) {
          for (let b = 1; b <= BALCONIES_PER_SIDE; b++) {
            const resolved = resolveBalconyFeature(collection.features, f, side, b, floorHeightDeltaM);
            if (resolved) stops.push({ floor: f, side, balcony: b, feature: resolved.feature });
          }
        }
      }
      setTourProgress({ current: 0, total: stops.length });

      // Floor is the OUTER loop: every window of every direction on this
      // floor is visited (North Window 1,2,3 -> East 1,2,3 -> South ->
      // West) before moving up to the next floor — walking the whole floor
      // plate first, since there's no wall stopping you from just walking
      // window-to-window once you're already inside.
      let previousStop: { floor: number; side: BalconySide } | null = null;
      for (let i = 0; i < stops.length; i++) {
        if (tourCancelledRef.current) break;
        await waitWhilePaused();
        if (tourCancelledRef.current) break;

        const { floor: f, side, balcony: b, feature } = stops[i];
        onFloorChange(f);
        onSideChange(side);
        onBalconyChange(b);
        const headingRad = computeOutwardHeadingRad(building.rotationRad, side);
        const [longitude, latitude, height] = feature.geometry.coordinates;
        const destination = Cesium.Cartesian3.fromDegrees(longitude, latitude, height);

        // Same facade as the previous stop (just a different window) —
        // glide sideways with no arc. Anything else (new direction or a
        // new floor) uses the normal arced flight, which is the right feel
        // for a bigger repositioning.
        const isAdjacentWindow = previousStop !== null && previousStop.floor === f && previousStop.side === side;
        if (isAdjacentWindow) {
          await glideBetweenWindows(destination, headingRad, 1.1);
        } else {
          await flyToBalconyPoseOnly(feature, headingRad, 1.6);
        }
        previousStop = { floor: f, side };
        setTourProgress({ current: i + 1, total: stops.length });
        setCurrentTourStop({
          side,
          balcony: b,
          floor: f,
          longitude,
          latitude,
          height,
          headingDeg: Cesium.Math.toDegrees(headingRad),
        });

        if (tourCancelledRef.current) break;
        await waitWhilePaused();
        if (tourCancelledRef.current) break;
        await wait(1100);
      }
    } finally {
      setIsTouring(false);
      setIsTourPaused(false);
    }
  }

  function handleStopTour() {
    tourCancelledRef.current = true;
    tourPausedRef.current = false;
    setIsTourPaused(false);
    setShowAutoNavModal(false);
    setCurrentTourStop(null);
    setTourProgress({ current: 0, total: 0 });
  }

  /**
   * Background scan: jumps to every saved/derived window on every floor,
   * captures the view and scores it, then sorts the results best-to-worst
   * GVI — a "which unit has the greenest view" report for a client, instead
   * of a cinematic walkthrough. Uses an instant camera snap (not flyTo/
   * glide) since nobody needs to watch this happen; a short pause after
   * each snap gives the newly-visible tiles/imagery a moment to render
   * before the screenshot is taken.
   */
  async function handleAutoCalculateGvi() {
    if (!viewer || isTouring || isCalculatingGvi) return;
    gviScanCancelledRef.current = false;
    setIsCalculatingGvi(true);
    setGviScanResults([]);
    indoorCamera.exit(viewer);
    try {
      if (!hasAnalyzedVegetation) {
        await onAnalyzeVegetation();
        setHasAnalyzedVegetation(true);
      }

      type Stop = { floor: number; side: BalconySide; balcony: number; feature: GalleryEntry["feature"]; isSaved: boolean };
      const stops: Stop[] = [];
      for (let f = 1; f <= TOTAL_BALCONY_FLOORS; f++) {
        for (const s of BALCONY_SIDES) {
          for (let b = 1; b <= BALCONIES_PER_SIDE; b++) {
            const resolved = resolveBalconyFeature(collection.features, f, s, b, floorHeightDeltaM);
            if (resolved) stops.push({ floor: f, side: s, balcony: b, feature: resolved.feature, isSaved: resolved.isSaved });
          }
        }
      }
      setGviScanProgress({ current: 0, total: stops.length });

      const polygons = listManualVegetationPolygons(manualVegetationCollection);
      const results: GviScanResult[] = [];
      // Only saved (Floor 1) entries actually live in `collection` — derived
      // floors 2-10 are computed on the fly and have nowhere local to store
      // a preview. Updating these keeps the gallery's own thumbnails fresh
      // immediately, independent of whether the backend refresh below
      // succeeds or has polled yet.
      const updatedFeaturesById = new Map<string, BalconyViewpointFeature>();
      for (let i = 0; i < stops.length; i++) {
        if (gviScanCancelledRef.current) break;
        const { floor: f, side: s, balcony: b, feature, isSaved } = stops[i];
        const headingRad = computeOutwardHeadingRad(building.rotationRad, s);
        const [longitude, latitude, height] = feature.geometry.coordinates;
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, height),
          orientation: { heading: headingRad, pitch: Cesium.Math.toRadians(-5), roll: 0 },
        });
        await wait(500);

        const captured = captureCurrentView(viewer, polygons);
        if (captured) {
          const result = await computeGVIFromDataUrl(captured.image, {
            generateMask: false,
            manualVegetationMask: captured.manualVegetationMask,
          });
          results.push({
            floor: f,
            side: s,
            balcony: b,
            gviScore: result.gviScore,
            previewImage: captured.image,
            feature,
          });

          // Reflect this window in the leaderboard/gallery immediately
          // rather than waiting for the whole 100-window scan to finish —
          // otherwise the modal sits on "No scan data yet" and the gallery
          // shows stale/no previews for the entire run.
          const sortedSoFar = [...results].sort((a, b) => b.gviScore - a.gviScore);
          setGviScanResults(sortedSoFar);
          saveGviScanResults(sortedSoFar);

          if (isSaved) {
            updatedFeaturesById.set(feature.properties.id, {
              ...feature,
              properties: {
                ...feature.properties,
                previewImage: captured.image,
                capturedAt: Date.now(),
                gviScore: result.gviScore,
              },
            });
            const nextFeatures = collection.features.map(
              (feat) => updatedFeaturesById.get(feat.properties.id) ?? feat
            );
            onPersistCollection({ ...collection, features: nextFeatures });
          }

          // Persisted to the backend (Postgres) immediately, one window at
          // a time, so the ranking survives forever — not just this
          // browser's localStorage — and a cancelled/interrupted scan still
          // keeps whatever it already finished.
          try {
            await manualCapture({
              floorNumber: f,
              direction: s,
              flatNumber: b,
              longitude,
              latitude,
              height,
              heading: Cesium.Math.toDegrees(headingRad),
              pitch: -5,
              roll: 0,
              previewImageDataUrl: captured.image,
              imageWidth: captured.width,
              imageHeight: captured.height,
              gviScore: result.gviScore,
              greenPixels: result.greenPixelCount,
              greyPixels: result.greyPixelCount ?? result.totalPixelCount - result.greenPixelCount,
              totalPixels: result.totalPixelCount,
            });
            // Pulls the just-saved row straight back from the backend so the
            // gallery's "remote" preview (which wins over the local one) is
            // confirmed to be coming from the database, not just the local
            // capture above.
            void refreshRemoteViewpoints();
          } catch (err) {
            console.warn(`Failed to persist GVI scan result for F${f}-${s}-${b} to the backend:`, err);
          }
        }
        setGviScanProgress({ current: i + 1, total: stops.length });
      }

      setShowLeaderboardModal(true);
    } finally {
      setIsCalculatingGvi(false);
    }
  }

  /**
   * Sync GVI button (leaderboard modal): the only trigger left for a scan
   * now that the panel's separate Rank/Rescan buttons are gone — always
   * runs a fresh scan of every saved window rather than silently reusing a
   * cached one, since "sync" implies the data is actually brought current.
   */
  function handleRankWindowsClick() {
    if (isCalculatingGvi) {
      handleCancelGviScan();
      return;
    }
    void handleAutoCalculateGvi();
  }

  function handleCancelGviScan() {
    gviScanCancelledRef.current = true;
  }

  /**
   * Permanently removes the top N ranked results (as currently sorted/shown)
   * from everywhere they live: the on-screen ranking list/leaderboard, the
   * localStorage fallback cache, the local gallery's own preview/GVI fields
   * for any that are saved (Floor 1) entries, and the backend database
   * (reset back to never-captured for that floor/side/window slot).
   */
  async function handleDeleteTopResults(count: number) {
    if (count <= 0 || gviScanResults.length === 0) return;
    const toDelete = gviScanResults.slice(0, count);
    const remaining = gviScanResults.slice(count);

    setGviScanResults(remaining);
    saveGviScanResults(remaining);

    // Only clears the preview/GVI fields — never removes the saved
    // position itself, since that's still the source of truth the camera
    // navigates to for that floor/side/window.
    const deletedIds = new Set(toDelete.map((r) => r.feature.properties.id));
    const hasMatchingSavedEntry = collection.features.some((f) => deletedIds.has(f.properties.id));
    if (hasMatchingSavedEntry) {
      const clearedFeatures = collection.features.map((f) =>
        deletedIds.has(f.properties.id)
          ? { ...f, properties: { ...f.properties, previewImage: undefined, gviScore: undefined } }
          : f
      );
      onPersistCollection({ ...collection, features: clearedFeatures });
    }

    try {
      const result = await resetSlots(
        toDelete.map((r) => ({ floorNumber: r.floor, direction: r.side, flatNumber: r.balcony }))
      );
      if (result.notFound > 0) {
        console.warn(`GVI leaderboard delete: ${result.notFound} of ${toDelete.length} slots had no backend record.`);
      }
    } catch (err) {
      console.warn("Failed to delete GVI results from the backend:", err);
    }
  }

  function handleGoToResult(result: GviScanResult) {
    if (!viewer) return;
    tourCancelledRef.current = true;
    tourPausedRef.current = false;
    setIsTourPaused(false);
    setTourProgress({ current: 0, total: 0 });
    setCurrentTourStop(null);
    setShowWindowDetails(false);
    setShowGviPanel(true);
    onFloorChange(result.floor);
    onSideChange(result.side);
    onBalconyChange(result.balcony);
    const headingRad = computeOutwardHeadingRad(building.rotationRad, result.side);
    flyToBalcony(viewer, result.feature, headingRad);
  }


  // --- Dragging ---
  const dragState = useRef<{ dragging: boolean; offsetX: number; offsetY: number }>({
    dragging: false,
    offsetX: 0,
    offsetY: 0,
  });

  function onHeaderMouseDown(event: React.MouseEvent) {
    dragState.current = {
      dragging: true,
      offsetX: event.clientX - position.left,
      offsetY: event.clientY - position.top,
    };
  }

  useEffect(() => {
    function onMove(event: MouseEvent) {
      if (!dragState.current.dragging) return;
      setPosition({
        left: event.clientX - dragState.current.offsetX,
        top: event.clientY - dragState.current.offsetY,
      });
    }
    function onUp() {
      dragState.current.dragging = false;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <>
    <div className="balcony-viewpoint-nav" style={{ top: position.top, left: position.left }}>
      <div className="balcony-viewpoint-nav__header" onMouseDown={onHeaderMouseDown}>
        <span>Balcony Viewpoints</span>
        <button
          type="button"
          className="minimize-btn"
          title={isMinimized ? "Expand" : "Minimize"}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => setIsMinimized((value) => !value)}
        >
          {isMinimized ? "▢" : "—"}
        </button>
      </div>
      {!isMinimized && (
        <div className="balcony-viewpoint-nav__body">
          <div className="field-label">Floor</div>
          <div className="floor-grid">
            {Array.from({ length: TOTAL_BALCONY_FLOORS }, (_, i) => i + 1).map((f) => (
              <button
                type="button"
                key={f}
                className={`floor-btn ${floor === f ? "active" : ""}`}
                onClick={() => {
                  tourCancelledRef.current = true;
                  tourPausedRef.current = false;
                  setIsTourPaused(false);
                  setCurrentTourStop(null);
                  setTourProgress({ current: 0, total: 0 });
                  onFloorChange(f);
                }}
              >
                {f}
              </button>
            ))}
          </div>

          <div className="field-label">Saved Views (Floor {floor})</div>
          {galleryEntries.length > 3 && (
            <input
              type="text"
              className="balcony-gallery__search"
              placeholder="Search by side or window…"
              value={gallerySearch}
              onChange={(event) => setGallerySearch(event.target.value)}
            />
          )}

          {sortedEntries.length === 0 ? (
            <p className="note">
              No saved viewpoints found for Floor {floor}.
              {galleryEntries.length === 0
                ? " Capture Floor 1 for a side/flat to see it here."
                : " Try a different search."}
            </p>
          ) : (
            <div className="balcony-gallery">
              {sortedEntries.map((entry) => {
                const isActive = entry.side === side && entry.balcony === balcony;
                const key = `${entry.side}-${entry.balcony}`;
                const remote = remoteByKey.get(key);
                // Backend-generated (automated pipeline) preview/GVI wins whenever
                // it exists — it's the real, permanently-stored screenshot; the
                // local capture/GVI fields are only ever a stopgap before that
                // exists for a given viewpoint.
                const previewImage = remote?.previewImageUrl ?? entry.feature.properties.previewImage;
                // Same priority as the preview image, plus a last resort: a
                // Sync GVI scan result for this exact floor/side/window — the
                // only place a derived (non-Floor-1) window's score can come
                // from, since only Floor 1 has anything saved locally.
                const gviScore =
                  remote?.gvi ??
                  entry.feature.properties.gviScore ??
                  gviScanResults.find(
                    (r) => r.floor === floor && r.side === entry.side && r.balcony === entry.balcony
                  )?.gviScore;
                return (
                  <div
                    key={key}
                    ref={isActive ? activeGalleryCardRef : undefined}
                    className={`balcony-gallery__card ${isActive ? "active" : ""}`}
                    onClick={() => handleGoToEntry(entry)}
                  >
                    {previewImage ? (
                      <div className="balcony-gallery__preview-wrap">
                        <img
                          className="balcony-gallery__preview-image"
                          src={previewImage}
                          alt={`${entry.side} Balcony, Window ${entry.balcony} preview`}
                        />
                        {gviScore !== undefined && (
                          <span className="balcony-gallery__gvi-badge">
                            {(gviScore * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="balcony-gallery__preview-placeholder balcony-gallery__no-preview">
                        <span>No Preview</span>
                      </div>
                    )}
                    <div className="balcony-gallery__title">{entry.side} Balcony</div>
                    <div className="balcony-gallery__subtitle">Window {entry.balcony}</div>
                    <button
                      type="button"
                      className="btn balcony-gallery__go-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleGoToEntry(entry);
                      }}
                      disabled={!viewer}
                    >
                      Go To View
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {vegetationErrorMessage && <p className="note error">{vegetationErrorMessage}</p>}
        </div>
      )}
    </div>

    {isTouring && (
      <div className="tour-control-bar">
        <div className="tour-control-bar__status">
          <span className="tour-control-bar__spinner" />
          {isTourPaused ? "Tour Paused" : "Auto Navigation Active"}
        </div>
        <div className="tour-control-bar__progress-track">
          <div
            className="tour-control-bar__progress-fill"
            style={{
              width: tourProgress.total > 0 ? `${(tourProgress.current / tourProgress.total) * 100}%` : "0%",
            }}
          />
        </div>
        <div className="tour-control-bar__buttons">
          {isTourPaused ? (
            <button type="button" className="btn primary" onClick={handleResumeTour}>
              ▶ Resume
            </button>
          ) : (
            <button type="button" className="btn" onClick={handlePauseTour}>
              ❚❚ Pause
            </button>
          )}
          <button type="button" className="btn danger" onClick={handleStopTour}>
            ✕ Cancel Tour
          </button>
        </div>
      </div>
    )}

    {((currentTourStop && showWindowDetails) || showGviPanel) && (
      <div className="top-right-overlay-stack">
        {currentTourStop && showWindowDetails && (
          <div className="window-details-panel">
            <div className="window-details-panel__header">
              <span>🪟 Window Details</span>
              <button
                type="button"
                className="window-details-panel__close"
                onClick={() => setShowWindowDetails(false)}
                aria-label="Close window details"
              >
                ✕
              </button>
            </div>
            <div className="window-details-panel__body">
              <div>
                <span>Side</span>
                <span>{currentTourStop.side}</span>
              </div>
              <div>
                <span>Window</span>
                <span>
                  {currentTourStop.side} Balcony - Window {currentTourStop.balcony}
                </span>
              </div>
              <div>
                <span>Floor</span>
                <span>{currentTourStop.floor}</span>
              </div>
            </div>
          </div>
        )}

        {showGviPanel && (
        <div className="paused-gvi-panel">
          <div className="paused-gvi-panel__header">
            <span>🔍 Analyse GVI</span>
            <button
              type="button"
              className="paused-gvi-panel__close"
              onClick={() => setShowGviPanel(false)}
              aria-label="Close Analyse GVI"
            >
              ✕
            </button>
          </div>
          <div className="paused-gvi-panel__body">
            <div className="field-label">Captured View</div>
            <div className="paused-gvi-panel__preview">
              {capturedView ? (
                <img src={capturedView.image} alt="Captured view preview" />
              ) : (
                <div className="paused-gvi-panel__placeholder">
                  <span className="paused-gvi-panel__placeholder-icon">🖼️</span>
                  <span>No image captured</span>
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn primary"
              onClick={() => void handleAnalyzeGvi()}
              disabled={!isViewerReady || !viewer || gviPipelineStage !== "idle"}
              title="Analyze vegetation, capture view, then compute GVI"
            >
              {gviPipelineLabel}
            </button>
            {capturedImageResult && (
              <>
                {capturedImageResult.maskDataUrl && (
                  <img
                    className="paused-gvi-panel__mask"
                    src={capturedImageResult.maskDataUrl}
                    alt="Green vs grey GVI classification"
                  />
                )}
                <div className="paused-gvi-panel__score">
                  GVI {(capturedImageResult.gviScore * 100).toFixed(1)}% green
                </div>
                <button
                  type="button"
                  className="btn debug-toggle"
                  onClick={() => setIsDebugPanelOpen((value) => !value)}
                >
                  {isDebugPanelOpen ? "▾ Hide Debug Info" : "▸ Show Debug Info"}
                </button>
                {isDebugPanelOpen && (
                  <div className="gvi-debug-panel">
                    <div>
                      <span>Total Pixels</span>
                      <span>{capturedImageResult.totalPixelCount.toLocaleString()}</span>
                    </div>
                    <div>
                      <span>Segmented Vegetation</span>
                      <span>{(capturedImageResult.segmentedVegetationPixelCount ?? 0).toLocaleString()}</span>
                    </div>
                    <div>
                      <span>Manual Vegetation</span>
                      <span>{(capturedImageResult.manualVegetationPixelCount ?? 0).toLocaleString()}</span>
                    </div>
                    <div>
                      <span>Merged Vegetation</span>
                      <span>{capturedImageResult.greenPixelCount.toLocaleString()}</span>
                    </div>
                    <div>
                      <span>Grey Pixels</span>
                      <span>{(capturedImageResult.greyPixelCount ?? 0).toLocaleString()}</span>
                    </div>
                    <div>
                      <span>Final GVI</span>
                      <span>{(capturedImageResult.gviScore * 100).toFixed(2)}%</span>
                    </div>
                    <div>
                      <span>Processing Time</span>
                      <span>{(capturedImageResult.processingTimeMs ?? 0).toFixed(0)} ms</span>
                    </div>
                    {capturedImageResult.thresholdsUsed && (
                      <>
                        <div>
                          <span>Hue Range</span>
                          <span>
                            {capturedImageResult.thresholdsUsed.minHueDeg}°–
                            {capturedImageResult.thresholdsUsed.maxHueDeg}°
                          </span>
                        </div>
                        <div>
                          <span>Min Saturation</span>
                          <span>{capturedImageResult.thresholdsUsed.minSaturation}</span>
                        </div>
                        <div>
                          <span>Min Value</span>
                          <span>{capturedImageResult.thresholdsUsed.minValue}</span>
                        </div>
                        <div>
                          <span>Min ExG</span>
                          <span>{capturedImageResult.thresholdsUsed.minExcessGreen}</span>
                        </div>
                        <div>
                          <span>Min Green Ratio</span>
                          <span>{capturedImageResult.thresholdsUsed.minGreenRatio}</span>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        )}
      </div>
    )}

    <button
      type="button"
      className={`auto-nav-toggle ${isTouring ? "active" : ""}`}
      onClick={isTouring ? handleStopTour : () => setShowAutoNavModal(true)}
      disabled={!viewer && !isTouring}
      title={isTouring ? "Stop tour" : "Auto Navigation"}
      aria-label="Auto Navigation"
    >
      {isTouring ? "⏹" : "🎬"}
    </button>

    <button
      type="button"
      className="gvi-leaderboard-toggle"
      onClick={() => setShowLeaderboardModal(true)}
      title="GVI Leaderboard"
      aria-label="GVI Leaderboard"
    >
      🏆
    </button>

    {showAutoNavModal && !isTouring && (
      <div className="gvi-leaderboard-backdrop" onClick={() => setShowAutoNavModal(false)}>
        <div className="auto-nav-modal" onClick={(event) => event.stopPropagation()}>
          <div className="gvi-leaderboard-modal__header">
            <span>🎬 Auto Navigation</span>
            <button
              type="button"
              className="gvi-leaderboard-modal__close"
              onClick={() => setShowAutoNavModal(false)}
              aria-label="Close Auto Navigation"
            >
              ✕
            </button>
          </div>
          <div className="auto-nav-modal__body">
            <div className="field-label">Tour which floor?</div>
            <div className="tour-floor-grid">
              {Array.from({ length: TOTAL_BALCONY_FLOORS }, (_, i) => i + 1).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`btn ${tourFloorScope === f ? "active" : ""}`}
                  onClick={() => {
                    setTourFloorScope(f);
                    void handleStartTour("all", f);
                  }}
                  title={`Auto-navigate every direction of Floor ${f} only`}
                >
                  {f}
                </button>
              ))}
              <button
                type="button"
                className={`btn ${tourFloorScope === "all" ? "active" : ""}`}
                onClick={() => {
                  setTourFloorScope("all");
                  void handleStartTour("all", "all");
                }}
                title="Auto-navigate every direction of every floor"
              >
                All
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {showLeaderboardModal && (
      <div className="gvi-leaderboard-backdrop" onClick={() => setShowLeaderboardModal(false)}>
        <div className="gvi-leaderboard-modal" onClick={(event) => event.stopPropagation()}>
          <div className="gvi-leaderboard-modal__header">
            <span>
              🏆 GVI Leaderboard{gviScanResults.length > 0 ? ` (${gviScanResults.length})` : ""}
            </span>
            <div className="gvi-leaderboard-modal__header-actions">
              <button
                type="button"
                className="gvi-leaderboard-modal__sync-btn"
                onClick={handleRankWindowsClick}
                disabled={!viewer || isTouring}
                title="Scan every window and re-rank by GVI"
              >
                {isCalculatingGvi
                  ? `⏳ Syncing… (${gviScanProgress.current}/${gviScanProgress.total}) — Cancel`
                  : "↻ Sync GVI"}
              </button>
              <button
                type="button"
                className="gvi-leaderboard-modal__close"
                onClick={() => setShowLeaderboardModal(false)}
                aria-label="Close GVI leaderboard"
              >
                ✕
              </button>
            </div>
          </div>
          {gviScanSavedAt && (
            <div className="gvi-leaderboard-modal__saved-at">
              Saved {new Date(gviScanSavedAt).toLocaleString()}
            </div>
          )}
          {gviScanResults.length > 0 && (
            <div className="gvi-leaderboard-modal__delete-row">
              <span>Delete top</span>
              <input
                type="number"
                min={1}
                max={gviScanResults.length}
                value={deleteTopCount}
                onChange={(event) => setDeleteTopCount(Number(event.target.value))}
              />
              <span>ranked entries</span>
              <button
                type="button"
                className="gvi-leaderboard-modal__delete-btn"
                onClick={() => void handleDeleteTopResults(deleteTopCount)}
                title="Delete these ranked results"
              >
                🗑 Delete
              </button>
            </div>
          )}
          <div className="gvi-leaderboard-modal__body">
            {gviScanResults.length === 0 ? (
              <p className="note">
                No scan data yet — click "Sync GVI" above to scan every saved window.
              </p>
            ) : (
              <div className="gvi-leaderboard-modal__grid">
                {gviScanResults.map((result, index) => (
                  <div
                    key={`${result.floor}-${result.side}-${result.balcony}`}
                    className="gvi-leaderboard-modal__row"
                    onClick={() => {
                      handleGoToResult(result);
                      setShowLeaderboardModal(false);
                    }}
                  >
                    <span className="gvi-leaderboard-modal__rank">#{index + 1}</span>
                    <img className="gvi-leaderboard-modal__thumb" src={result.previewImage} alt="" />
                    <div className="gvi-leaderboard-modal__info">
                      <span className="gvi-leaderboard-modal__title">
                        Floor {result.floor} · {result.side} · Window {result.balcony}
                      </span>
                      <span
                        className={`gvi-leaderboard-modal__score ${
                          result.gviScore >= 0.15 ? "high" : result.gviScore >= 0.05 ? "mid" : "low"
                        }`}
                      >
                        {(result.gviScore * 100).toFixed(1)}% green
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
