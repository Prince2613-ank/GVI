import { Fragment, useState } from "react";
import { CardinalDirection } from "../utils/constants";
import { FloorGVIProfile, GVIProfileProgress } from "../services/gviProfile";

// BuildingGVIProfile surfaces the per-floor GVI ranking used for the
// underlying business case: floors with more visible greenery from their
// windows can be priced higher, floors with less can be priced lower. This
// component only presents the measured ranking — it intentionally does not
// invent a pricing formula, since that's a business decision for whoever
// operates the building, not something to infer from pixel-green ratios.
//
// Clicking a floor row expands it to show the exact view captured at each
// of the 4 facades, so the score for that floor can be visually audited
// instead of taken on faith. Clicking one of those thumbnails flies the
// live 3D camera to that exact floor + facade, so the snapshot and the
// interactive view always show the same thing.

interface BuildingGVIProfileProps {
  isRunning: boolean;
  progress: GVIProfileProgress | null;
  profiles: FloorGVIProfile[] | null;
  onRun: () => void;
  onSelectFacade: (floor: number, direction: CardinalDirection) => void;
}

export function BuildingGVIProfile({
  isRunning,
  progress,
  profiles,
  onRun,
  onSelectFacade,
}: BuildingGVIProfileProps) {
  const [expandedFloor, setExpandedFloor] = useState<number | null>(null);
  const percent = progress ? Math.round((progress.done / progress.total) * 100) : 0;

  function handleRowClick(floor: number) {
    setExpandedFloor((current) => (current === floor ? null : floor));
  }

  return (
    <fieldset className="panel">
      <legend>Building GVI Profile</legend>

      <p className="note">
        Scans every floor and facade, averaging each floor's Green View Index
        across all 4 directions — a defensible per-floor green-exposure
        ranking to inform rent/pricing tiers (higher GVI floors command a
        premium, lower GVI floors less). Click a floor to see the view
        captured at each direction.
      </p>

      <button className="btn primary" onClick={onRun} disabled={isRunning} type="button">
        {isRunning ? "Scanning..." : "Compute Full Building GVI Profile"}
      </button>

      {isRunning && progress && (
        <>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>
          <p className="status status-info">
            Floor {progress.floor}, {progress.direction} — {progress.done}/
            {progress.total} ({percent}%)
          </p>
        </>
      )}

      {profiles && !isRunning && (
        <div className="profile-table-wrap">
          <table className="profile-table">
            <thead>
              <tr>
                <th>Floor</th>
                <th>Avg GVI</th>
                <th>Rank</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <Fragment key={p.floor}>
                  <tr
                    className="profile-row-clickable"
                    onClick={() => handleRowClick(p.floor)}
                  >
                    <td>{p.floor}</td>
                    <td>{(p.avgGviScore * 100).toFixed(1)}%</td>
                    <td>#{p.rank}</td>
                  </tr>
                  {expandedFloor === p.floor && (
                    <tr>
                      <td colSpan={3}>
                        <div className="facade-thumb-grid">
                          {p.byDirection.map((facade) => (
                            <button
                              key={facade.direction}
                              className="facade-thumb"
                              type="button"
                              title={`Fly the camera to floor ${p.floor}, ${facade.direction}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onSelectFacade(p.floor, facade.direction);
                              }}
                            >
                              <img src={facade.thumbnail} alt={`${facade.direction} view`} />
                              <span>
                                {facade.direction}: {(facade.gviScore * 100).toFixed(1)}%
                              </span>
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </fieldset>
  );
}
