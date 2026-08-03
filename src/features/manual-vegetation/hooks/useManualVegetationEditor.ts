import { useEffect, useMemo, useRef, useState } from "react";
import * as Cesium from "cesium";
import {
  ManualVegetationCollection,
  ManualVegetationPolygon,
  LonLat,
} from "../types/ManualVegetationTypes";
import {
  listManualVegetationPolygons,
  makePolygonFromPositions,
  removeManualVegetationPolygon,
  saveManualVegetationCollection,
  upsertManualVegetationPolygon,
} from "../storage/VegetationStorage";
import { computePolygonAreaM2, computePolygonCentroid } from "../services/PolygonGeometry";
import { pickGroundPosition } from "../services/PolygonEditor";
import { ManualVegetationOverlay } from "../projection/VegetationOverlay";

/**
 * Entity picks expose `id` as the Entity object itself (string id at
 * `.id.id`); GeometryInstance/GroundPrimitive picks (used for the saved
 * polygon fills — see VegetationOverlay.ts) expose `id` as the raw string
 * directly. Saved-polygon selection and vertex-handle dragging need to
 * handle both shapes since one pick can land on either kind of primitive.
 */
function extractPickId(picked: { id?: unknown } | undefined): string | undefined {
  if (!picked) return undefined;
  if (typeof picked.id === "string") return picked.id;
  const nested = (picked.id as { id?: unknown } | undefined)?.id;
  return typeof nested === "string" ? nested : undefined;
}

export function useManualVegetationEditor(
  viewer: Cesium.Viewer | null,
  collection: ManualVegetationCollection,
  onPersist: (next: ManualVegetationCollection) => void,
  /** Saved polygons only render once this is true — tied to the "Analyze
   * Nearby Vegetation" button, not shown by default on load. */
  showSaved: boolean
) {
  const [isMappingEnabled, setIsMappingEnabled] = useState(false);
  const [draftPoints, setDraftPoints] = useState<LonLat[]>([]);
  const [isDraftFinished, setIsDraftFinished] = useState(false);
  const [selectedPolygonId, setSelectedPolygonId] = useState<string | null>(null);
  const draggingVertexRef = useRef<{ polygonId: string; vertexIndex: number } | null>(null);
  const pendingDragPointRef = useRef<LonLat | null>(null);

  const overlayRef = useRef<ManualVegetationOverlay | null>(null);
  const polygons = useMemo(() => listManualVegetationPolygons(collection), [collection]);

  useEffect(() => {
    if (!viewer) return;
    const overlay = new ManualVegetationOverlay(viewer);
    overlayRef.current = overlay;
    return () => {
      overlay.destroy();
      overlayRef.current = null;
    };
  }, [viewer]);

  // Keep the persistent saved-polygon layer in sync with storage + selection.
  // Also re-fires on `viewer` itself: the overlay is created asynchronously
  // (once `viewer` goes from null -> ready), and without `viewer` here this
  // effect would only ever re-run when polygons/selection change — missing
  // the very first render entirely if the overlay wasn't ready yet.
  useEffect(() => {
    overlayRef.current?.renderSaved(showSaved ? polygons : [], selectedPolygonId);
  }, [polygons, selectedPolygonId, viewer, showSaved]);

  useEffect(() => {
    overlayRef.current?.renderDraft(draftPoints);
  }, [draftPoints]);

  useEffect(() => {
    const selected = polygons.find((p) => p.id === selectedPolygonId) ?? null;
    overlayRef.current?.renderHandles(selected);
  }, [polygons, selectedPolygonId, viewer]);

  // Drawing: left-click adds a vertex, double-click finishes. Only active
  // while mapping mode is enabled and the draft hasn't been finished yet.
  useEffect(() => {
    if (!viewer || !isMappingEnabled || isDraftFinished) return;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const point = pickGroundPosition(viewer, event.position);
      if (!point) return;
      setDraftPoints((current) => [...current, point]);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction(() => {
      setIsDraftFinished(true);
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

    return () => handler.destroy();
  }, [viewer, isMappingEnabled, isDraftFinished]);

  // Selecting a saved polygon (view/edit mode) and dragging its vertex handles.
  // Disabled entirely while actively drawing a new polygon so clicks aren't ambiguous.
  useEffect(() => {
    if (!viewer || isMappingEnabled) return;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = viewer.scene.pick(event.position);
      const entityId = extractPickId(picked);
      if (!entityId) {
        setSelectedPolygonId(null);
        return;
      }
      const polygonId = ManualVegetationOverlay.idToPolygonId(entityId);
      if (polygonId) {
        setSelectedPolygonId(polygonId);
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = viewer.scene.pick(event.position);
      const entityId = extractPickId(picked);
      const handle = entityId ? ManualVegetationOverlay.parseHandleId(entityId) : null;
      if (!handle) return;
      draggingVertexRef.current = handle;
      viewer.scene.screenSpaceCameraController.enableInputs = false;
    }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      const dragging = draggingVertexRef.current;
      if (!dragging) return;
      const point = pickGroundPosition(viewer, event.endPosition);
      if (!point) return;

      // Only move the one handle entity for live visual feedback here —
      // NOT onPersist. Persisting on every mouse-move (60+/sec) used to
      // trigger a full re-render of every saved polygon's fill/outline
      // (plus a terrain re-sample) on each pixel of drag, which is what
      // made dragging feel slow. The real commit — the one full rebuild —
      // happens once, on LEFT_UP below.
      pendingDragPointRef.current = point;
      overlayRef.current?.moveHandle(dragging.polygonId, dragging.vertexIndex, point);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction(() => {
      const dragging = draggingVertexRef.current;
      const point = pendingDragPointRef.current;
      if (dragging && point) {
        const polygon = polygons.find((p) => p.id === dragging.polygonId);
        if (polygon) {
          const nextPositions = polygon.positions.map((p, i) => (i === dragging.vertexIndex ? point : p));
          const updated: ManualVegetationPolygon = {
            ...polygon,
            positions: nextPositions,
            areaM2: computePolygonAreaM2(nextPositions),
            centroid: computePolygonCentroid(nextPositions),
            updatedAt: Date.now(),
          };
          onPersist(upsertManualVegetationPolygon(collection, updated));
        }
      }
      pendingDragPointRef.current = null;
      draggingVertexRef.current = null;
      viewer.scene.screenSpaceCameraController.enableInputs = true;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    return () => {
      handler.destroy();
      viewer.scene.screenSpaceCameraController.enableInputs = true;
    };
  }, [viewer, isMappingEnabled, polygons, collection, onPersist]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (isMappingEnabled) {
          setDraftPoints([]);
          setIsDraftFinished(false);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMappingEnabled]);

  function toggleMapping() {
    setIsMappingEnabled((value) => {
      const next = !value;
      if (next) {
        setSelectedPolygonId(null);
      } else {
        setDraftPoints([]);
        setIsDraftFinished(false);
      }
      return next;
    });
  }

  function undoLastPoint() {
    setDraftPoints((current) => current.slice(0, -1));
  }

  function finishPolygon() {
    if (draftPoints.length >= 3) setIsDraftFinished(true);
  }

  function cancelDraft() {
    setDraftPoints([]);
    setIsDraftFinished(false);
  }

  function saveDraftPolygon(name: string) {
    if (draftPoints.length < 3) return;
    const polygon = makePolygonFromPositions(draftPoints, name || `Vegetation ${polygons.length + 1}`);
    const next = upsertManualVegetationPolygon(collection, polygon);
    onPersist(next);
    saveManualVegetationCollection(next);

    setDraftPoints([]);
    setIsDraftFinished(false);
  }

  function clearSelectedPolygon() {
    setSelectedPolygonId(null);
  }

  /** Selecting from the list, not just by clicking the (possibly invisible) map primitive. */
  function selectPolygon(id: string) {
    setSelectedPolygonId(id);
  }

  function deleteSelectedPolygon() {
    if (!selectedPolygonId) return;
    onPersist(removeManualVegetationPolygon(collection, selectedPolygonId));
    setSelectedPolygonId(null);
  }

  return {
    polygons,
    isMappingEnabled,
    toggleMapping,
    draftPoints,
    isDraftFinished,
    undoLastPoint,
    finishPolygon,
    cancelDraft,
    saveDraftPolygon,
    selectedPolygonId,
    selectPolygon,
    clearSelectedPolygon,
    deleteSelectedPolygon,
  };
}
