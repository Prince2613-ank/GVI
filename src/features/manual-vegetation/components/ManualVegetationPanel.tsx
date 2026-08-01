import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import { ManualVegetationCollection } from "../types/ManualVegetationTypes";
import { useManualVegetationEditor } from "../hooks/useManualVegetationEditor";
import { exportManualVegetationGeoJson } from "../services/GeoJsonExporter";
import { importManualVegetationGeoJson } from "../services/GeoJsonImporter";
import {
  runPolygonDiagnostics,
  clearDiagnostics,
  flyToPolygon,
  DiagnosticsReport,
} from "../services/PolygonDiagnostics";
import "./ManualVegetationPanel.css";

interface ManualVegetationPanelProps {
  viewer: Cesium.Viewer | null;
  collection: ManualVegetationCollection;
  onPersist: (next: ManualVegetationCollection) => void;
  /** Saved polygons only render once this is true — tied to the "Analyze
   * Nearby Vegetation" button, not shown by default on load. */
  showSaved: boolean;
}

/**
 * Debug tool for manually correcting missing vegetation (courtyards, tree
 * groups between buildings, private gardens, etc.) that the automated
 * fetch/segmentation pipeline doesn't pick up. Saved polygons are unioned
 * into every future captured-image GVI analysis (see ProjectionService.ts +
 * services/gvi.ts) — this only ever ADDS vegetation, never removes any.
 */
export function ManualVegetationPanel({ viewer, collection, onPersist, showSaved }: ManualVegetationPanelProps) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [position, setPosition] = useState({ top: 80, left: 660 });
  const [draftName, setDraftName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [diagnosticsReport, setDiagnosticsReport] = useState<DiagnosticsReport | null>(null);
  const [isRunningDiagnostics, setIsRunningDiagnostics] = useState(false);

  const {
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
  } = useManualVegetationEditor(viewer, collection, onPersist, showSaved);

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

  function handleSave() {
    saveDraftPolygon(draftName.trim());
    setDraftName("");
  }

  async function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const imported = await importManualVegetationGeoJson(file);
      const merged = new Map(collection.features.map((f) => [f.id, f]));
      imported.features.forEach((f) => merged.set(f.id, f));
      onPersist({ type: "FeatureCollection", features: Array.from(merged.values()) });
    } catch (error) {
      window.alert(`Failed to import GeoJSON: ${(error as Error).message}`);
    }
  }

  const selectedPolygon = polygons.find((p) => p.id === selectedPolygonId) ?? null;

  async function handleRunDiagnostics() {
    if (!viewer || !selectedPolygon) return;
    setIsRunningDiagnostics(true);
    try {
      const report = await runPolygonDiagnostics(viewer, selectedPolygon);
      setDiagnosticsReport(report);
    } finally {
      setIsRunningDiagnostics(false);
    }
  }

  function handleClearDiagnostics() {
    if (viewer) clearDiagnostics(viewer);
    setDiagnosticsReport(null);
  }

  function handleZoomToPolygon() {
    if (viewer && selectedPolygon) flyToPolygon(viewer, selectedPolygon);
  }

  return (
    <div className="manual-veg-panel" style={{ top: position.top, left: position.left }}>
      <div className="manual-veg-panel__header" onMouseDown={onHeaderMouseDown}>
        <span>Manual Vegetation Mapper</span>
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
        <div className="manual-veg-panel__body">
          <p className="note">
            Draw polygons over tree groups missing from the vegetation layer (courtyards, gardens,
            gaps between buildings). Saved polygons are always counted as vegetation in future
            captured-image GVI analysis.
          </p>

          <button
            type="button"
            className={`btn primary ${isMappingEnabled ? "active" : ""}`}
            onClick={toggleMapping}
            disabled={!viewer}
          >
            {isMappingEnabled ? "🔴 Mapping Enabled — Click to Stop" : "Enable Mapping"}
          </button>

          {isMappingEnabled && (
            <>
              <p className="note">
                Click to add vertices ({draftPoints.length} so far). Double-click or "Finish
                Polygon" to close the ring.
              </p>
              <div className="button-row">
                <button type="button" className="btn" onClick={finishPolygon} disabled={draftPoints.length < 3}>
                  Finish Polygon
                </button>
                <button type="button" className="btn" onClick={undoLastPoint} disabled={draftPoints.length === 0}>
                  Undo Last Point
                </button>
                <button type="button" className="btn" onClick={cancelDraft} disabled={draftPoints.length === 0}>
                  Cancel
                </button>
              </div>

              {isDraftFinished && (
                <div className="manual-veg-panel__save-row">
                  <input
                    type="text"
                    placeholder={`Vegetation ${polygons.length + 1}`}
                    value={draftName}
                    onChange={(event) => setDraftName(event.target.value)}
                  />
                  <button type="button" className="btn primary" onClick={handleSave}>
                    Save Vegetation Polygon
                  </button>
                </div>
              )}
            </>
          )}

          {!isMappingEnabled && (
            <>
              <div className="field-label">Saved Polygons ({polygons.length})</div>
              <div className="manual-veg-panel__list">
                {polygons.length === 0 && <p className="note">None yet — enable mapping to draw one.</p>}
                {polygons.map((polygon) => (
                  <div
                    key={polygon.id}
                    className={`manual-veg-panel__list-item ${polygon.id === selectedPolygonId ? "selected" : ""}`}
                    onClick={() => selectPolygon(polygon.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <span>{polygon.name}</span>
                    <span>{polygon.areaM2.toFixed(0)} m²</span>
                  </div>
                ))}
              </div>

              {selectedPolygon && (
                <div className="button-row">
                  <button type="button" className="btn" onClick={clearSelectedPolygon}>
                    Clear Selected Polygon
                  </button>
                  <button type="button" className="btn danger" onClick={deleteSelectedPolygon}>
                    Delete Polygon
                  </button>
                </div>
              )}

              {selectedPolygon && (
                <div className="manual-veg-panel__diagnostics">
                  <div className="field-label">Polygon Debug — {selectedPolygon.name}</div>
                  <div className="button-row">
                    <button
                      type="button"
                      className="btn"
                      onClick={handleRunDiagnostics}
                      disabled={!viewer || isRunningDiagnostics}
                    >
                      {isRunningDiagnostics ? "Running…" : "Run Diagnostics"}
                    </button>
                    <button type="button" className="btn" onClick={handleClearDiagnostics}>
                      Clear Diagnostics
                    </button>
                    <button type="button" className="btn" onClick={handleZoomToPolygon} disabled={!viewer}>
                      Zoom To Polygon
                    </button>
                  </div>

                  {diagnosticsReport && (
                    <ul className="manual-veg-panel__diagnostics-list">
                      {diagnosticsReport.stages.map((stage, index) => (
                        <li key={index} className={stage.passed ? "pass" : "fail"}>
                          <strong>{stage.passed ? "✅" : "❌"} {stage.label}</strong>
                          {stage.details && <div className="detail">{stage.details}</div>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}

          <div className="button-row">
            <button
              type="button"
              className="btn"
              onClick={() => exportManualVegetationGeoJson(collection)}
              disabled={collection.features.length === 0}
            >
              Export GeoJSON
            </button>
            <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
              Import GeoJSON
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".geojson,application/geo+json,application/json"
              onChange={handleImportFile}
            />
          </div>
        </div>
      )}
    </div>
  );
}
