import { WindowMetadata, WindowResult } from "./types";

// Standalone popup for a selected window: id/floor/flat/room/direction
// breakdown/green%/eye height/eye coordinates, per spec. Rendered as a
// plain positioned div by the caller (App.tsx) rather than a Cesium
// entity's built-in InfoBox, so its styling matches the rest of the app's
// sidebar/panel look.

interface WindowPopupProps {
  window: WindowMetadata;
  result: WindowResult | undefined;
  onClose: () => void;
}

export function WindowPopup({ window, result, onClose }: WindowPopupProps) {
  return (
    <div className="panel" style={{ position: "absolute", top: 16, left: 16, width: 280 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong>{window.id}</strong>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      <table className="debug-table">
        <tbody>
          <tr>
            <td>Floor</td>
            <td>{window.floor}</td>
          </tr>
          <tr>
            <td>Flat</td>
            <td>{window.flat}</td>
          </tr>
          <tr>
            <td>Room</td>
            <td>{window.room}</td>
          </tr>
          <tr>
            <td>Source</td>
            <td>{window.source}</td>
          </tr>
          {result ? (
            <>
              <tr>
                <td>Eye Height</td>
                <td>{result.eyeHeightM.toFixed(2)} m</td>
              </tr>
              <tr>
                <td>Eye Coordinates</td>
                <td>
                  {result.eyePosition.latitude.toFixed(6)},{" "}
                  {result.eyePosition.longitude.toFixed(6)} @{" "}
                  {result.eyePosition.height.toFixed(1)}m
                </td>
              </tr>
              <tr>
                <td>Average GVI</td>
                <td>{result.averageGviPercent.toFixed(1)}%</td>
              </tr>
              {result.average360GviPercent !== undefined && (
                <tr>
                  <td>360° Average</td>
                  <td>{result.average360GviPercent.toFixed(1)}%</td>
                </tr>
              )}
              {result.capturedViewGviPercent !== undefined && (
                <tr>
                  <td>Captured View GVI</td>
                  <td>{result.capturedViewGviPercent.toFixed(1)}%</td>
                </tr>
              )}
            </>
          ) : (
            <tr>
              <td colSpan={2}>Not analyzed yet.</td>
            </tr>
          )}
        </tbody>
      </table>

      {result?.capturedViewDataUrl && (
        <img
          src={result.capturedViewDataUrl}
          alt="Captured window view"
          style={{ width: "100%", borderRadius: 4, marginTop: 6 }}
        />
      )}

      {result && (
        <table className="debug-table">
          <thead>
            <tr>
              <td>Direction</td>
              <td>Green %</td>
            </tr>
          </thead>
          <tbody>
            {result.directions.map((d) => (
              <tr key={d.direction}>
                <td>{d.direction}</td>
                <td>{d.gviPercent.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
