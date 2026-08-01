// CanopyDebugPanel exposes the map-layer debug toggles owned by App.tsx
// (see gis/VegetationLayer.ts's setTreesVisible/setCanopyVisible/
// setTreeCentersVisible/setCanopyVisibilityColoring, and
// GVIProjectionOverlay for gviProjection) — all off-by-default visual aids
// for auditing the canopy-based GVI pipeline, not production UI.

export interface CanopyDebugToggles {
  treeCenters: boolean;
  canopyPolygons: boolean;
  trees3D: boolean;
  visibleCanopy: boolean;
  occludedCanopy: boolean;
  gviProjection: boolean;
}

interface CanopyDebugPanelProps {
  toggles: CanopyDebugToggles;
  onChange: (toggles: CanopyDebugToggles) => void;
}

const TOGGLE_LABELS: Record<keyof CanopyDebugToggles, string> = {
  trees3D: "3D Trees",
  canopyPolygons: "Canopy Polygons",
  treeCenters: "Tree Centers",
  visibleCanopy: "Visible Canopy",
  occludedCanopy: "Occluded Canopy",
  gviProjection: "GVI Projection Overlay",
};

export function CanopyDebugPanel({ toggles, onChange }: CanopyDebugPanelProps) {
  const setToggle = (key: keyof CanopyDebugToggles, value: boolean) => {
    onChange({ ...toggles, [key]: value });
  };

  return (
    <fieldset className="panel">
      <legend>Canopy Debug</legend>
      {(Object.keys(TOGGLE_LABELS) as (keyof CanopyDebugToggles)[]).map((key) => (
        <label className="checkbox-row" key={key}>
          <input
            type="checkbox"
            checked={toggles[key]}
            onChange={(e) => setToggle(key, e.target.checked)}
          />
          {TOGGLE_LABELS[key]}
        </label>
      ))}
    </fieldset>
  );
}
