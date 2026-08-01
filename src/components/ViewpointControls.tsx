// ViewpointControls lets the interactive view sample any point along the
// selected facade (a floor plate holds multiple units, each with its own
// window/balcony — not just one at dead-center) and look out at any yaw/
// pitch angle, instead of only ever the facade midpoint looking perfectly
// perpendicular. The full-building GVI scan intentionally keeps the
// standardized center/level viewpoint for a consistent per-floor ranking;
// these controls only affect the single interactive view.

interface ViewpointControlsProps {
  facadeOffsetRatio: number;
  headingOffsetDeg: number;
  pitchDeg: number;
  onChangeFacadeOffsetRatio: (value: number) => void;
  onChangeHeadingOffsetDeg: (value: number) => void;
  onChangePitchDeg: (value: number) => void;
  onReset: () => void;
}

export function ViewpointControls({
  facadeOffsetRatio,
  headingOffsetDeg,
  pitchDeg,
  onChangeFacadeOffsetRatio,
  onChangeHeadingOffsetDeg,
  onChangePitchDeg,
  onReset,
}: ViewpointControlsProps) {
  return (
    <fieldset className="panel">
      <legend>Viewpoint (Position on Flat)</legend>

      <p className="note">
        A floor plate has multiple units along each facade — move along the
        facade and angle the view to sample a specific window or balcony
        instead of only the facade's center point.
      </p>

      <label className="field">
        Position Along Facade
        <input
          type="range"
          min={-1}
          max={1}
          step={0.05}
          value={facadeOffsetRatio}
          onChange={(e) => onChangeFacadeOffsetRatio(parseFloat(e.target.value))}
        />
        <span>
          {facadeOffsetRatio === 0
            ? "Center"
            : `${facadeOffsetRatio > 0 ? "+" : ""}${facadeOffsetRatio.toFixed(2)}`}
        </span>
      </label>

      <label className="field">
        Look Yaw Offset
        <input
          type="range"
          min={-60}
          max={60}
          step={1}
          value={headingOffsetDeg}
          onChange={(e) => onChangeHeadingOffsetDeg(parseFloat(e.target.value))}
        />
        <span>{headingOffsetDeg}°</span>
      </label>

      <label className="field">
        Look Pitch
        <input
          type="range"
          min={-45}
          max={45}
          step={1}
          value={pitchDeg}
          onChange={(e) => onChangePitchDeg(parseFloat(e.target.value))}
        />
        <span>{pitchDeg}°</span>
      </label>

      <button className="btn" onClick={onReset} type="button">
        Reset to Center / Level
      </button>
    </fieldset>
  );
}
