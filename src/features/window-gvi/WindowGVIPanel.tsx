import { useCallback, useMemo, useRef, useState } from "react";
import * as Cesium from "cesium";
import { BuildingTransform } from "../../services/camera";
import { VegetationCategory } from "../../services/vegetation";
import {
  BUILDING_MODEL_URL,
  FLOOR_HEIGHT_M,
  MODEL_BASE_OFFSET_M,
} from "../../utils/constants";
import { computeCameraHeightM } from "../../utils/cameraUtils";
import { WindowManager } from "./WindowManager";
import { ResultStore, downloadTextFile } from "./ResultStore";
import { RayVisualizer } from "./RayVisualization";
import { analyzeWindow } from "./ViewAnalyzer";
import { rollUpBuilding, rollUpFlats, rollUpRooms } from "./GVIEngine";
import { ClassifierContext } from "./VegetationClassifier";
import {
  DEFAULT_RAY_CAST_CONFIG,
  RayCastConfig,
  VIEW_DIRECTIONS,
  WindowMetadata,
} from "./types";

// The Window GVI sidebar: wires WindowManager (import/detect), ViewAnalyzer
// (analyze one/floor/building), ResultStore (results + export), and
// RayVisualizer (the "Toggle Rays" debug view) into one control surface.
// WindowOverlay (rendered separately in App.tsx, alongside this panel)
// reads the same ResultStore/WindowManager state for the on-globe markers.

interface WindowGVIPanelProps {
  viewer: Cesium.Viewer | null;
  buildingEntity: Cesium.Entity | null;
  building: BuildingTransform;
  vegetationCategoryById: Map<string, VegetationCategory>;
  windows: WindowMetadata[];
  onWindowsChange: (windows: WindowMetadata[]) => void;
  resultStore: ResultStore;
  selectedWindowId: string | null;
  onSelectWindow: (windowId: string | null) => void;
  heatmapEnabled: boolean;
  onToggleHeatmap: (enabled: boolean) => void;
  raysEnabled: boolean;
  onToggleRays: (enabled: boolean) => void;
}

function floorFootHeightLocalUp(building: BuildingTransform, floor: number): number {
  return (
    MODEL_BASE_OFFSET_M * building.scale + computeCameraHeightM(floor, FLOOR_HEIGHT_M, 0)
  );
}

export function WindowGVIPanel({
  viewer,
  buildingEntity,
  building,
  vegetationCategoryById,
  windows,
  onWindowsChange,
  resultStore,
  selectedWindowId,
  onSelectWindow,
  heatmapEnabled,
  onToggleHeatmap,
  raysEnabled,
  onToggleRays,
}: WindowGVIPanelProps) {
  const managerRef = useRef(new WindowManager());
  const rayVisualizerRef = useRef<RayVisualizer | null>(null);
  const [status, setStatus] = useState<string>("No windows loaded.");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [rayCount, setRayCount] = useState(DEFAULT_RAY_CAST_CONFIG.rayCount);
  const [include360, setInclude360] = useState(false);
  const [captureView, setCaptureView] = useState(false);
  const [, forceRerender] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const config: RayCastConfig = useMemo(
    () => ({ ...DEFAULT_RAY_CAST_CONFIG, rayCount }),
    [rayCount]
  );

  const context: ClassifierContext = useMemo(
    () => ({ vegetationCategoryById, buildingEntity }),
    [vegetationCategoryById, buildingEntity]
  );

  function getRayVisualizer(): RayVisualizer | null {
    if (!viewer) return null;
    if (!rayVisualizerRef.current) {
      rayVisualizerRef.current = new RayVisualizer(viewer);
    }
    return rayVisualizerRef.current;
  }

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const { loaded, rejected } = managerRef.current.loadFromJson(parsed);
        onWindowsChange(managerRef.current.getWindows());
        setStatus(
          rejected > 0
            ? `Imported ${loaded} windows (${rejected} entries rejected — check shape).`
            : `Imported ${loaded} windows from JSON.`
        );
      } catch (err) {
        setStatus(`Failed to import: ${err instanceof Error ? err.message : "invalid JSON"}`);
      }
    },
    [onWindowsChange]
  );

  const handleDetect = useCallback(async () => {
    setStatus("Detecting windows from GLB mesh names...");
    try {
      const detected = await managerRef.current.detectFromGlb(BUILDING_MODEL_URL);
      onWindowsChange(managerRef.current.getWindows());
      setStatus(
        detected.length > 0
          ? `Auto-detected ${detected.length} window(s) from mesh names. Verify positions/normals — see WindowManager.ts's detectFromGlb comment on axis assumptions.`
          : "No window/glass-named meshes found in the GLB. Import a JSON metadata file instead."
      );
    } catch (err) {
      setStatus(`Detection failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }, [onWindowsChange]);

  const runAnalysis = useCallback(
    async (targets: WindowMetadata[]) => {
      if (!viewer) {
        setStatus("Viewer not ready.");
        return;
      }
      setIsAnalyzing(true);
      const visualizer = raysEnabled ? getRayVisualizer() : null;

      for (let i = 0; i < targets.length; i++) {
        const w = targets[i];
        setStatus(`Analyzing ${w.id} (${i + 1}/${targets.length})...`);
        const footUp = floorFootHeightLocalUp(building, w.floor);
        // eslint-disable-next-line no-await-in-loop
        const result = await analyzeWindow(
          viewer.scene,
          building,
          w,
          footUp,
          [...VIEW_DIRECTIONS],
          config,
          context,
          (direction, done, total) => {
            setStatus(
              `Analyzing ${w.id} — ${direction} ray ${done}/${total} (window ${i + 1}/${targets.length})`
            );
          },
          include360,
          visualizer
            ? (direction, origin, hits, classifications) => {
                if (direction === "Forward") {
                  visualizer.show(origin, hits, classifications);
                }
              }
            : undefined,
          viewer,
          captureView
        );
        resultStore.set(result);
        forceRerender((n) => n + 1);
      }

      setIsAnalyzing(false);
      setStatus(`Analysis complete: ${targets.length} window(s).`);
    },
    [viewer, building, config, context, include360, raysEnabled, captureView, resultStore]
  );

  const selectedWindow = selectedWindowId ? managerRef.current.getWindow(selectedWindowId) : null;

  const buildingRollup = useMemo(
    () => rollUpBuilding(resultStore.getAll()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resultStore, windows.length]
  );

  return (
    <fieldset className="panel">
      <legend>Window GVI</legend>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        style={{ display: "none" }}
        onChange={handleFileSelected}
      />

      <div className="field">
        <button type="button" onClick={handleImportClick}>
          Import Metadata (JSON)
        </button>
      </div>
      <div className="field">
        <button type="button" onClick={handleDetect}>
          Detect Windows from GLB
        </button>
      </div>

      <p className="debug-status" style={{ display: "block" }}>
        {windows.length} window(s) loaded
      </p>

      <label className="field">
        Ray count per direction
        <input
          type="number"
          min={8}
          max={5000}
          step={8}
          value={rayCount}
          onChange={(e) => setRayCount(Math.max(8, parseInt(e.target.value, 10) || 8))}
        />
      </label>
      {rayCount > 500 && (
        <p className="debug-status drift" style={{ display: "block" }}>
          High ray counts are slow — each ray is a real scene pick, not a
          cheap test. 500+ rays per direction can take many seconds per
          window.
        </p>
      )}

      <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={include360}
          onChange={(e) => setInclude360(e.target.checked)}
        />
        Include 360° sweep
      </label>

      <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={captureView}
          onChange={(e) => setCaptureView(e.target.checked)}
        />
        Detect from captured view (real rendered pixels)
      </label>

      <div className="field">
        <button
          type="button"
          disabled={isAnalyzing || !selectedWindow}
          onClick={() => selectedWindow && runAnalysis([selectedWindow])}
        >
          Analyze Selected Window
        </button>
      </div>
      <div className="field">
        <button
          type="button"
          disabled={isAnalyzing || windows.length === 0}
          onClick={() => {
            const floor = selectedWindow?.floor ?? windows[0]?.floor;
            runAnalysis(managerRef.current.getWindowsForFloor(floor));
          }}
        >
          Analyze Floor
        </button>
      </div>
      <div className="field">
        <button
          type="button"
          disabled={isAnalyzing || windows.length === 0}
          onClick={() => runAnalysis(windows)}
        >
          Analyze Building ({windows.length} windows)
        </button>
      </div>

      <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={heatmapEnabled}
          onChange={(e) => onToggleHeatmap(e.target.checked)}
        />
        Toggle Heatmap
      </label>
      <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={raysEnabled}
          onChange={(e) => {
            onToggleRays(e.target.checked);
            if (!e.target.checked) rayVisualizerRef.current?.clear();
          }}
        />
        Toggle Rays
      </label>

      <div className="field">
        <button
          type="button"
          disabled={resultStore.getAll().length === 0}
          onClick={() => downloadTextFile("window-gvi-results.csv", resultStore.toCsv(), "text/csv")}
        >
          Export CSV
        </button>
      </div>
      <div className="field">
        <button
          type="button"
          disabled={resultStore.getAll().length === 0}
          onClick={() =>
            downloadTextFile("window-gvi-results.json", resultStore.toJson(), "application/json")
          }
        >
          Export JSON
        </button>
      </div>

      <p style={{ fontSize: 11, color: "#9aa4ad" }}>{status}</p>

      {selectedWindow && (
        <div className="debug-table" style={{ marginTop: 6 }}>
          <table className="debug-table">
            <tbody>
              <tr>
                <td>Selected</td>
                <td>{selectedWindow.id}</td>
              </tr>
              <tr>
                <td>Floor / Flat / Room</td>
                <td>
                  {selectedWindow.floor} / {selectedWindow.flat} / {selectedWindow.room}
                </td>
              </tr>
              {resultStore.get(selectedWindow.id) && (
                <tr>
                  <td>Average GVI</td>
                  <td>{resultStore.get(selectedWindow.id)!.averageGviPercent.toFixed(1)}%</td>
                </tr>
              )}
            </tbody>
          </table>
          <button type="button" onClick={() => onSelectWindow(null)}>
            Clear Selection
          </button>
        </div>
      )}

      {buildingRollup.floors.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <strong>Building GVI: {buildingRollup.averageGviPercent.toFixed(1)}%</strong>
          <table className="debug-table">
            <tbody>
              {buildingRollup.floors.map((f) => (
                <tr key={f.floor}>
                  <td>Floor {f.floor}</td>
                  <td>{f.averageGviPercent.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </fieldset>
  );
}

// Re-exported for WindowPopup / App-level rollup displays that only need
// room/flat aggregation without the full building tree.
export { rollUpRooms, rollUpFlats };
