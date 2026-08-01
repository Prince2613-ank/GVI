import { CardinalDirection } from "../utils/constants";
import { VegetationLoadState } from "../hooks/useVegetation";
import { GVIResult } from "../services/gvi";
import { CanopyGVIResult } from "../services/gviCanopy";
import { CanopyReport, TreeHeightReport } from "../services/vegetation";

// GVIPanel (STEP 11 + STEP 14): displays current floor/window/camera state,
// nearby vegetation counts, capture/compute controls, and result + status.

interface GVIPanelProps {
  floor: number;
  direction: CardinalDirection;
  cameraHeightM: number;
  vegetationState: VegetationLoadState;
  vegetationError: string | null;
  vegetationPartialFailures: string[];
  totalTrees: number;
  totalParks: number;
  totalForests: number;
  treeHeightReport: TreeHeightReport;
  canopyReport: CanopyReport;
  isComputingGvi: boolean;
  /** Authoritative score: camera -> visible canopy area -> area ratio (services/gviCanopy.ts). */
  canopyGviResult: CanopyGVIResult | null;
  /** Optional debug/audit score from the old pixel-classification approach. */
  gviResult: GVIResult | null;
  showPixelGviDebug: boolean;
  onToggleShowPixelGviDebug: (value: boolean) => void;
  capturedImage: string | null;
  onCapture: () => void;
  isComputingVisibility: boolean;
  visibleTreeCount: number;
  obstructedTreeCount: number;
  onRetryVegetation: () => void;
}

export function GVIPanel({
  floor,
  direction,
  cameraHeightM,
  vegetationState,
  vegetationError,
  vegetationPartialFailures,
  totalTrees,
  totalParks,
  totalForests,
  treeHeightReport,
  canopyReport,
  isComputingGvi,
  canopyGviResult,
  gviResult,
  showPixelGviDebug,
  onToggleShowPixelGviDebug,
  capturedImage,
  onCapture,
  isComputingVisibility,
  visibleTreeCount,
  obstructedTreeCount,
  onRetryVegetation,
}: GVIPanelProps) {
  return (
    <fieldset className="panel">
      <legend>Green View Index</legend>

      <div className="stat-grid">
        <Stat label="Current Floor" value={floor} />
        <Stat label="Window" value={direction} />
        <Stat label="Camera Height" value={`${cameraHeightM.toFixed(1)} m`} />
        <Stat label="Nearby Trees" value={totalTrees} />
        <Stat label="Nearby Parks" value={totalParks} />
        <Stat label="Nearby Forests" value={totalForests} />
        <Stat label="LiDAR Heights" value={treeHeightReport.lidar} />
        <Stat label="Estimated Heights" value={treeHeightReport.estimated} />
        <Stat label="Default Heights" value={treeHeightReport.defaults} />
      </div>

      {treeHeightReport.invalid > 0 && (
        <p className="status status-warning">
          {treeHeightReport.invalid} trees still have invalid height values.
          See console warnings for their IDs.
        </p>
      )}

      <div className="stat-grid">
        <Stat label="Real Canopy (LiDAR)" value={canopyReport.lidarPolygon} />
        <Stat label="Crown-Radius Circle" value={canopyReport.crownRadiusCircle} />
        <Stat label="Species Ellipse" value={canopyReport.speciesEllipse} />
        <Stat label="Circle Fallback" value={canopyReport.circleFallback} />
        <Stat label="Avg Canopy Area" value={`${canopyReport.avgCanopyAreaM2.toFixed(1)} m²`} />
        <Stat label="Avg Crown Diameter" value={`${canopyReport.avgCrownDiameterM.toFixed(1)} m`} />
      </div>

      {vegetationState === "loading" && (
        <p className="status status-info">Loading vegetation...</p>
      )}
      {vegetationState === "error" && (
        <>
          <p className="status status-error">
            API Error{vegetationError ? `: ${vegetationError}` : ""}
          </p>
          <button className="btn" onClick={onRetryVegetation} type="button">
            Retry Vegetation Fetch
          </button>
        </>
      )}
      {vegetationState === "loaded" &&
        totalTrees + totalParks + totalForests === 0 && (
          <p className="status status-warning">No vegetation found</p>
        )}

      {vegetationPartialFailures.length > 0 && (
        <>
          <p className="status status-warning">
            Some vegetation sources failed: {vegetationPartialFailures.join("; ")}.
            Greenery visible in the captured image from that source (e.g. a
            park polygon Overpass would have supplied) won't be in the
            stats or map markers below until this succeeds.
          </p>
          <button className="btn" onClick={onRetryVegetation} type="button">
            Retry Vegetation Fetch
          </button>
        </>
      )}

      {isComputingVisibility ? (
        <p className="status status-info">Analyzing sightlines...</p>
      ) : (
        visibleTreeCount + obstructedTreeCount > 0 && (
          <>
            <div className="stat-grid">
              <Stat label="Mapped Trees Visible in Frame" value={visibleTreeCount} />
              <Stat label="Trees Blocked by Buildings" value={obstructedTreeCount} />
            </div>
            <p className="note">
              Blocked trees are dimmed gray on the map. The captured-image GVI
              already excludes them naturally (an occluded tree simply isn't
              in the rendered frame) — this is a per-tree audit of why.
            </p>
          </>
        )
      )}

      <button className="btn primary" onClick={onCapture} type="button">
        Capture View &amp; Compute GVI
      </button>

      {isComputingGvi && <p className="status status-info">Computing GVI...</p>}

      {canopyGviResult && (
        <div className="gvi-result">
          <div className="stat-grid">
            <Stat
              label="Visible Canopy Area"
              value={`${canopyGviResult.visibleCanopyAreaPx2.toFixed(0)} px²`}
            />
            <Stat
              label="Total Screen Area"
              value={`${canopyGviResult.totalAreaPx2.toFixed(0)} px²`}
            />
            <Stat
              label="GVI Score"
              value={`${(canopyGviResult.gviScore * 100).toFixed(1)}%`}
            />
          </div>
          <p className="note">
            Camera-based canopy GVI: real tree canopy polygons visible from
            this exact floor and window camera, with buildings occluding
            hidden portions via ray casting, projected onto the image plane.
            Not a pixel classification of a screenshot.
          </p>
        </div>
      )}

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={showPixelGviDebug}
          onChange={(e) => onToggleShowPixelGviDebug(e.target.checked)}
        />
        Also compute legacy pixel-classification GVI (debug/audit)
      </label>

      {capturedImage && (
        <>
          <p className="note">Captured view</p>
          <img className="capture-preview" src={capturedImage} alt="Captured window view" />
        </>
      )}

      {showPixelGviDebug && gviResult && (
        <div className="gvi-result">
          <div className="stat-grid">
            <Stat label="Green Pixels" value={gviResult.greenPixelCount} />
            <Stat label="Pixels In Window View" value={gviResult.totalPixelCount} />
            <Stat
              label="Pixel GVI Score (debug)"
              value={`${(gviResult.gviScore * 100).toFixed(1)}%`}
            />
          </div>
          <p className="note">
            Legacy HSV pixel-classification score, kept only as a debug
            comparison against the canopy-based score above.
          </p>
        </div>
      )}

      {showPixelGviDebug && gviResult?.maskDataUrl && (
        <>
          <p className="note">
            Green = visible mapped vegetation. Black/gray = buildings,
            terrain, roads, water, and sky counted as non-vegetation.
          </p>
          <img
            className="capture-preview"
            src={gviResult.maskDataUrl}
            alt="Vegetation classification mask"
          />
        </>
      )}
    </fieldset>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
