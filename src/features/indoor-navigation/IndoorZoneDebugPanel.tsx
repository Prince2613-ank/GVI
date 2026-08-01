import { useEffect, useState } from "react";
import { indoorCamera, IndoorZoneLimits } from "../indoor-camera/IndoorCameraController";
import "./IndoorZoneDebugPanel.css";

const MIN_LIMIT_M = 0;
const MAX_LIMIT_M = 7;
const STEP_M = 0.05;

interface LimitRowProps {
  label: string;
  valueM: number;
  onChange: (nextM: number) => void;
}

function LimitRow({ label, valueM, onChange }: LimitRowProps) {
  return (
    <label className="indoor-zone-debug-panel__row">
      <span className="indoor-zone-debug-panel__row-label">
        {label} <strong>{valueM.toFixed(2)} m</strong>
      </span>
      <input
        type="range"
        min={MIN_LIMIT_M}
        max={MAX_LIMIT_M}
        step={STEP_M}
        value={valueM}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/**
 * Debug card for live-tuning the CURRENT viewpoint's movement boundary (see
 * IndoorZone.ts / IndoorMovementConfig.ts) — lets you dial in exactly how
 * far the camera can move toward the window, back into the room, and side
 * to side for this specific balcony, without editing config and reloading.
 * Only rendered while both indoor mode AND the "Indoor Debug" toggle are on
 * (see IndoorNavigationOverlay). Changes apply immediately to the active
 * zone only — they don't persist past leaving/re-entering the viewpoint,
 * since each entry recomputes a fresh zone from IndoorMovementConfig's
 * static defaults.
 */
export function IndoorZoneDebugPanel() {
  const [limits, setLimits] = useState<IndoorZoneLimits | null>(() => indoorCamera.getActiveZoneLimits());

  useEffect(() => {
    // Re-syncs whenever a (possibly new) viewpoint is entered/exited — e.g.
    // jumping straight from one balcony to another re-computes a fresh zone
    // with its own default limits, which this panel should reflect instead
    // of showing stale values from the previous window.
    return indoorCamera.subscribe(() => {
      setLimits(indoorCamera.getActiveZoneLimits());
    });
  }, []);

  if (!limits) return null;

  function update(overrides: Partial<IndoorZoneLimits>) {
    setLimits((previous) => {
      if (!previous) return previous;
      indoorCamera.setActiveZoneLimits(overrides);
      return { ...previous, ...overrides };
    });
  }

  return (
    <div className="indoor-zone-debug-panel" role="group" aria-label="Balcony view movement limits">
      <div className="indoor-zone-debug-panel__title">Balcony View Limits</div>
      <LimitRow
        label="Forward (to window)"
        valueM={limits.forwardLimit}
        onChange={(forwardLimit) => update({ forwardLimit })}
      />
      <LimitRow
        label="Backward (into room)"
        valueM={limits.backLimit}
        onChange={(backLimit) => update({ backLimit })}
      />
      <LimitRow label="Left / Right" valueM={limits.sideLimit} onChange={(sideLimit) => update({ sideLimit })} />
    </div>
  );
}
