import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import { BuildingTransform, computeWindowCameraPose, flyCameraToPose } from "../../services/camera";
import { computeOutwardHeadingRad } from "../../utils/cameraUtils";
import { computeGVIFromDataUrl } from "../../services/gvi";
import {
  BALCONIES_PER_SIDE,
  BALCONY_SIDES,
  BalconySide,
  BalconyViewpointCollection,
  TOTAL_BALCONY_FLOORS,
  makeBalconyId,
} from "./BalconyTypes";
import { makeBalconyFeature, capturePreviewImage } from "./BalconyCapture";
import { upsertBalconyFeature } from "./BalconyStorage";
import { exportBalconyGeoJson } from "./BalconyGeoJson";
import { importPositions, manualCapture } from "./balconyGenerationApi";
import "./LiveBalconyPositionDebug.css";

interface LiveBalconyPositionDebugProps {
  viewer: Cesium.Viewer | null;
  building: BuildingTransform;
  collection: BalconyViewpointCollection;
  onPersist: (next: BalconyViewpointCollection) => void;
  floor: number;
  side: BalconySide;
  balcony: number;
  onFloorChange: (floor: number) => void;
  onSideChange: (side: BalconySide) => void;
  onBalconyChange: (balcony: number) => void;
}

interface LiveCoordinate {
  longitude: number;
  latitude: number;
  height: number;
}

/**
 * Spreads balcony 1/2/3 across the facade width instead of stacking them at
 * the same center point, mirroring computeWindowCameraPose's facadeOffsetRatio.
 */
function facadeRatioForBalcony(balcony: number): number {
  return (balcony - (BALCONIES_PER_SIDE + 1) / 2) / ((BALCONIES_PER_SIDE - 1) / 2 || 1);
}

const MOVE_STEP_OPTIONS_M = [0.1, 0.25, 0.5, 1, 2];
const LOOK_STEP_OPTIONS_DEG = [0.5, 1, 2, 5];

/**
 * The one balcony-viewpoint capture tool: live cursor lat/long/height
 * readout, a floor/side/flat quick-nav that flies near the target facade,
 * manual nudge/look/rotate controls to lock the exact eye position, and
 * "Save Point" which writes that flat's full viewpoint (id, floor, side,
 * balcony, lon/lat/height) into the shared GeoJSON FeatureCollection —
 * exportable at any time via "Export GeoJSON" for sharing/reuse as the
 * default dataset.
 */
export function LiveBalconyPositionDebug({
  viewer,
  building,
  collection,
  onPersist,
  floor,
  side,
  balcony,
  onFloorChange,
  onSideChange,
  onBalconyChange,
}: LiveBalconyPositionDebugProps) {
  const [liveCoordinate, setLiveCoordinate] = useState<LiveCoordinate | null>(null);
  const [cameraPosition, setCameraPosition] = useState<LiveCoordinate | null>(null);
  const [flownToId, setFlownToId] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(true);
  const [position, setPosition] = useState({ top: 0, right: 0 });
  const [isLocked, setIsLocked] = useState(false);
  const [moveStepM, setMoveStepM] = useState(0.5);
  const [lookStepDeg, setLookStepDeg] = useState(1);

  const selectedId = makeBalconyId(floor, side, balcony);

  useEffect(() => {
    if (!viewer) return;
    function onPostRender() {
      const cartographic = Cesium.Cartographic.fromCartesian(viewer!.camera.positionWC);
      setCameraPosition({
        longitude: Cesium.Math.toDegrees(cartographic.longitude),
        latitude: Cesium.Math.toDegrees(cartographic.latitude),
        height: cartographic.height,
      });
    }
    viewer.scene.postRender.addEventListener(onPostRender);
    return () => {
      viewer.scene.postRender.removeEventListener(onPostRender);
    };
  }, [viewer]);

  // Lock disables the default mouse/touch camera controller so the nudge
  // buttons below are the only thing that can move the camera while fixing
  // an exact point of view. Always restore inputs on unmount/toggle-off so
  // a stray unmount never leaves the viewer permanently uncontrollable.
  useEffect(() => {
    if (!viewer) return;
    viewer.scene.screenSpaceCameraController.enableInputs = !isLocked;
    return () => {
      viewer.scene.screenSpaceCameraController.enableInputs = true;
    };
  }, [viewer, isLocked]);

  function nudgeMove(action: (viewer: Cesium.Viewer, distance: number) => void) {
    if (!viewer) return;
    action(viewer, moveStepM);
  }

  function nudgeLook(action: (viewer: Cesium.Viewer, angleRad: number) => void) {
    if (!viewer) return;
    action(viewer, Cesium.Math.toRadians(lookStepDeg));
  }

  useEffect(() => {
    if (!viewer) return;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((event: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      const cartesian = viewer.scene.pickPositionSupported
        ? viewer.scene.pickPosition(event.endPosition)
        : viewer.camera.pickEllipsoid(event.endPosition, viewer.scene.globe.ellipsoid);
      if (!cartesian) {
        setLiveCoordinate(null);
        return;
      }
      const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
      setLiveCoordinate({
        longitude: Cesium.Math.toDegrees(cartographic.longitude),
        latitude: Cesium.Math.toDegrees(cartographic.latitude),
        height: cartographic.height,
      });
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
    return () => handler.destroy();
  }, [viewer]);

  function handleFlyToFlat(b: number) {
    if (!viewer) return;
    const pose = computeWindowCameraPose(building, floor, side, {
      facadeOffsetRatio: facadeRatioForBalcony(b),
    });
    onBalconyChange(b);
    setFlownToId(makeBalconyId(floor, side, b));
    setSavedMessage(null);
    void flyCameraToPose(viewer, pose);
  }

  async function handleSavePoint() {
    if (!cameraPosition || !viewer) return;
    // Always re-captures a fresh screenshot on save — re-saving an already
    // saved id (e.g. after nudging the camera) replaces the old preview
    // rather than leaving a stale one attached to the new position.
    const previewImage = capturePreviewImage(viewer);
    const feature = makeBalconyFeature(selectedId, floor, side, balcony, cameraPosition, {
      previewImage,
      capturedAt: Date.now(),
    });
    const next = upsertBalconyFeature(collection, feature);
    // Saving only updates the one shared collection (localStorage + markers).
    // A file only gets written out when "Export GeoJSON" is clicked, so every
    // flat across every floor ends up combined into a single, floor-sorted
    // balcony_viewpoints.geojson instead of a new download per save.
    onPersist(next);
    setSavedMessage(`Saved ${selectedId} — ${next.features.length} point(s) saved so far`);

    // Also push this EXACT live capture straight into the backend as a
    // permanently completed viewpoint — this is the real screenshot the
    // user just verified with their own eyes, so there's no need to make
    // the automation queue re-fly here and re-capture it later.
    try {
      const highResImage = capturePreviewImage(viewer, 1280, 720, 0.9);
      const gvi = await computeGVIFromDataUrl(highResImage, { generateMask: true });
      await manualCapture({
        floorNumber: floor,
        direction: side,
        flatNumber: balcony,
        longitude: cameraPosition.longitude,
        latitude: cameraPosition.latitude,
        height: cameraPosition.height,
        heading: computeOutwardHeadingRad(building.rotationRad, side),
        pitch: Cesium.Math.toRadians(-5),
        roll: 0,
        previewImageDataUrl: highResImage,
        maskImageDataUrl: gvi.maskDataUrl,
        imageWidth: 1280,
        imageHeight: 720,
        gviScore: gvi.gviScore,
        greenPixels: gvi.greenPixelCount,
        greyPixels: gvi.greyPixelCount ?? gvi.totalPixelCount - gvi.greenPixelCount,
        totalPixels: gvi.totalPixelCount,
      });
      setSavedMessage(`Saved ${selectedId} locally AND stored permanently in the backend`);
    } catch (error) {
      setSavedMessage(
        `Saved ${selectedId} locally, but backend storage failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  function handleExportGeoJson() {
    exportBalconyGeoJson(collection);
    setSavedMessage(`Exported balcony_viewpoints.geojson (${collection.features.length} point${
      collection.features.length === 1 ? "" : "s"
    })`);
  }

  async function handleSyncPositionsToBackend() {
    if (collection.features.length === 0) return;
    setSavedMessage("Syncing positions to backend…");
    try {
      const positions = collection.features.map((f) => ({
        floorNumber: f.properties.floor,
        direction: f.properties.side,
        flatNumber: f.properties.balcony,
        longitude: f.geometry.coordinates[0],
        latitude: f.geometry.coordinates[1],
        height: f.geometry.coordinates[2],
      }));
      const result = await importPositions(positions);
      setSavedMessage(
        `Synced ${result.updated} position(s) to backend — they'll be regenerated with your exact camera pose` +
          (result.notFound > 0 ? ` (${result.notFound} not found there yet — run "Generate Entire Building" first)` : "")
      );
    } catch (error) {
      setSavedMessage(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const isAlreadySaved = collection.features.some((f) => f.properties.id === selectedId);

  // --- Dragging ---
  const dragState = useRef<{ dragging: boolean; offsetX: number; offsetY: number }>({
    dragging: false,
    offsetX: 0,
    offsetY: 0,
  });

  function onHeaderMouseDown(event: React.MouseEvent) {
    dragState.current = {
      dragging: true,
      offsetX: window.innerWidth - event.clientX - position.right,
      offsetY: event.clientY - position.top,
    };
  }

  useEffect(() => {
    function onMouseMove(event: MouseEvent) {
      if (!dragState.current.dragging) return;
      setPosition({
        right: window.innerWidth - event.clientX - dragState.current.offsetX,
        top: event.clientY - dragState.current.offsetY,
      });
    }
    function onMouseUp() {
      dragState.current.dragging = false;
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return (
    <div className="live-balcony-position-debug" style={{ top: position.top, right: position.right }}>
      <div className="live-balcony-position-debug__header" onMouseDown={onHeaderMouseDown}>
        <span>Live Balcony Position Debug</span>
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
      <div className="live-balcony-position-debug__body">
        <div className="field-label">Live Cursor Position</div>
        <table className="debug-table">
          <tbody>
            <tr>
              <td>Lon</td>
              <td>{liveCoordinate ? liveCoordinate.longitude.toFixed(7) : "—"}</td>
            </tr>
            <tr>
              <td>Lat</td>
              <td>{liveCoordinate ? liveCoordinate.latitude.toFixed(7) : "—"}</td>
            </tr>
            <tr>
              <td>Height</td>
              <td>{liveCoordinate ? `${liveCoordinate.height.toFixed(2)} m` : "—"}</td>
            </tr>
          </tbody>
        </table>
        <p className="note">
          Move the mouse over the scene to read the exact lat/long/height under the cursor —
          use this to manually verify a balcony point before capturing it.
        </p>

        <div className="field-label">Camera (Point of View) Position</div>
        <table className="debug-table">
          <tbody>
            <tr>
              <td>Lon</td>
              <td>{cameraPosition ? cameraPosition.longitude.toFixed(7) : "—"}</td>
            </tr>
            <tr>
              <td>Lat</td>
              <td>{cameraPosition ? cameraPosition.latitude.toFixed(7) : "—"}</td>
            </tr>
            <tr>
              <td>Height</td>
              <td>{cameraPosition ? `${cameraPosition.height.toFixed(2)} m` : "—"}</td>
            </tr>
          </tbody>
        </table>

        <div className="field-label">Movement Controls</div>
        <div className="move-pad">
          <button type="button" className="btn" onClick={() => nudgeMove((v, d) => v.camera.moveForward(d))}>
            ⤒ Fwd
          </button>
          <button type="button" className="btn" onClick={() => nudgeMove((v, d) => v.camera.moveUp(d))}>
            ⬆ Up
          </button>
          <button type="button" className="btn" onClick={() => nudgeMove((v, d) => v.camera.moveBackward(d))}>
            ⤓ Back
          </button>
          <button type="button" className="btn" onClick={() => nudgeMove((v, d) => v.camera.moveLeft(d))}>
            ⬅ Left
          </button>
          <button type="button" className="btn" onClick={() => nudgeMove((v, d) => v.camera.moveDown(d))}>
            ⬇ Down
          </button>
          <button type="button" className="btn" onClick={() => nudgeMove((v, d) => v.camera.moveRight(d))}>
            ➡ Right
          </button>
        </div>
        <label className="field-label" htmlFor="live-balcony-move-step">
          Move step (m)
        </label>
        <select
          id="live-balcony-move-step"
          value={moveStepM}
          onChange={(event) => setMoveStepM(Number(event.target.value))}
        >
          {MOVE_STEP_OPTIONS_M.map((step) => (
            <option key={step} value={step}>
              {step}
            </option>
          ))}
        </select>

        <div className="field-label">Look Controls</div>
        <div className="look-pad">
          <button type="button" className="btn" onClick={() => nudgeLook((v, a) => v.camera.lookUp(a))}>
            Look ⬆
          </button>
          <button type="button" className="btn" onClick={() => nudgeLook((v, a) => v.camera.lookLeft(a))}>
            Look ⬅
          </button>
          <button type="button" className="btn" onClick={() => nudgeLook((v, a) => v.camera.lookRight(a))}>
            Look ➡
          </button>
          <button type="button" className="btn" onClick={() => nudgeLook((v, a) => v.camera.lookDown(a))}>
            Look ⬇
          </button>
        </div>
        <label className="field-label" htmlFor="live-balcony-look-step">
          Look step (deg)
        </label>
        <select
          id="live-balcony-look-step"
          value={lookStepDeg}
          onChange={(event) => setLookStepDeg(Number(event.target.value))}
        >
          {LOOK_STEP_OPTIONS_DEG.map((step) => (
            <option key={step} value={step}>
              {step}
            </option>
          ))}
        </select>


        <div className="button-row">
          <button
            type="button"
            className={`btn ${isLocked ? "active" : ""}`}
            onClick={() => setIsLocked((value) => !value)}
            disabled={!viewer}
            title={
              isLocked
                ? "Unlock to let mouse drag/scroll move the camera again"
                : "Lock the view so only the nudge buttons above can move the camera"
            }
          >
            {isLocked ? "🔒 View Locked" : "🔓 Lock View"}
          </button>
        </div>

        <div className="field-label">Selected Flat</div>
        <div className="current-id">
          {selectedId}
          {isAlreadySaved ? " (saved)" : ""}
        </div>
        <div className="button-row">
          <button
            type="button"
            className="btn primary"
            onClick={() => void handleSavePoint()}
            disabled={!cameraPosition}
            title={
              cameraPosition
                ? `Save the current locked camera position as ${selectedId}'s point of view`
                : "Camera position not available yet"
            }
          >
            Save Point for {selectedId}
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleExportGeoJson}
            disabled={collection.features.length === 0}
            title="Export every saved/locked point of view captured so far as balcony_viewpoints.geojson"
          >
            Export GeoJSON
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={handleSyncPositionsToBackend}
            disabled={collection.features.length === 0}
            title="Push these exact manually-verified positions into the automated generation backend, replacing its generic formula guess for each matching viewpoint"
          >
            Sync Positions to Backend
          </button>
        </div>
        {savedMessage && <p className="note saved">{savedMessage}</p>}

        <label className="field-label" htmlFor="live-balcony-floor-select">
          Floor
        </label>
        <select
          id="live-balcony-floor-select"
          value={floor}
          onChange={(event) => onFloorChange(Number(event.target.value))}
        >
          {Array.from({ length: TOTAL_BALCONY_FLOORS }, (_, i) => i + 1).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>

        <div className="field-label">Side</div>
        <div className="radio-row">
          {BALCONY_SIDES.map((s) => (
            <label key={s}>
              <input type="radio" name="live-balcony-side" checked={side === s} onChange={() => onSideChange(s)} />
              {s}
            </label>
          ))}
        </div>

        <div className="field-label">Flat No.</div>
        <div className="button-row">
          {Array.from({ length: BALCONIES_PER_SIDE }, (_, i) => i + 1).map((b) => {
            const id = makeBalconyId(floor, side, b);
            const saved = collection.features.some((f) => f.properties.id === id);
            return (
              <button
                type="button"
                key={b}
                className={`btn ${flownToId === id ? "active" : ""} ${saved ? "saved" : ""}`}
                disabled={!viewer}
                title={`Fly near ${id}${saved ? " (already saved)" : ""}`}
                onClick={() => handleFlyToFlat(b)}
              >
                {id}
                {saved ? " ✓" : ""}
              </button>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}
