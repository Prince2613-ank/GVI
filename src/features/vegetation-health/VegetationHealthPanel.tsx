import { useEffect, useState } from "react";
import { fetchVegetationHealth, VegetationHealthResult } from "./vegetationHealthApi";
import "./VegetationHealthPanel.css";

const RING_RADIUS = 60;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function scoreColor(score: number): string {
  if (score >= 80) return "#8bc34a";
  if (score >= 60) return "#c0d868";
  if (score >= 40) return "#ffca28";
  return "#ef5350";
}

function scoreLabel(score: number): string {
  if (score >= 80) return "Thriving Urban Canopy";
  if (score >= 60) return "Healthy Canopy";
  if (score >= 40) return "Moderate Stress Signs";
  return "Canopy Needs Attention";
}

function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let raf: number;
    const start = performance.now();
    function tick(now: number) {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(target * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

function HeroCard({ result }: { result: VegetationHealthResult }) {
  const animated = useCountUp(result.overallScore);
  const dashOffset = RING_CIRCUMFERENCE * (1 - animated / 100);
  const color = scoreColor(result.overallScore);

  return (
    <div className="veghealth-hero">
      <div className="veghealth-hero__ring-wrap">
        <svg width="140" height="140">
          <circle className="veghealth-hero__ring-bg" cx="70" cy="70" r={RING_RADIUS} />
          <circle
            className="veghealth-hero__ring-fg"
            cx="70"
            cy="70"
            r={RING_RADIUS}
            stroke={color}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <div className="veghealth-hero__score">
          <span className="veghealth-hero__score-num" style={{ color }}>
            {Math.round(animated)}
          </span>
          <span className="veghealth-hero__score-max">/ 100</span>
        </div>
      </div>
      <div className="veghealth-hero__label" style={{ color }}>
        {scoreLabel(result.overallScore)}
      </div>
      <div className="veghealth-hero__sublabel">Vegetation Health Score</div>
    </div>
  );
}

function ConditionBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total === 0 ? 0 : (count / total) * 100;
  return (
    <div className="veghealth-bar-row">
      <span className="veghealth-bar-row__label">{label}</span>
      <div className="veghealth-bar-row__track">
        <div className="veghealth-bar-row__fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="veghealth-bar-row__count">{count}</span>
    </div>
  );
}

export function VegetationHealthPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [result, setResult] = useState<VegetationHealthResult | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");

  useEffect(() => {
    if (!isOpen || loadState !== "idle") return;
    setLoadState("loading");
    fetchVegetationHealth()
      .then((data) => {
        setResult(data);
        setLoadState("loaded");
      })
      .catch(() => setLoadState("error"));
  }, [isOpen, loadState]);

  function retry() {
    setLoadState("idle");
  }

  return (
    <>
      <button
        type="button"
        className={`veghealth-toggle ${isOpen ? "active" : ""}`}
        onClick={() => setIsOpen((v) => !v)}
        title="Vegetation Health"
        aria-label="Vegetation Health"
      >
        🩺
      </button>

      {isOpen && (
        <div className="veghealth-panel" role="dialog" aria-label="Vegetation Health">
          <div className="veghealth-panel__header">
            <span className="veghealth-panel__title">Vegetation Health</span>
            <button
              type="button"
              className="veghealth-panel__close"
              onClick={() => setIsOpen(false)}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <div className="veghealth-panel__body">
            {loadState === "loading" && (
              <div className="veghealth-panel__loading">Analyzing tree condition data…</div>
            )}

            {loadState === "error" && (
              <div className="veghealth-panel__error">
                Couldn't load vegetation health data.
                <div>
                  <button type="button" className="veghealth-panel__retry" onClick={retry}>
                    Retry
                  </button>
                </div>
              </div>
            )}

            {loadState === "loaded" && result && (
              <>
                <HeroCard result={result} />

                <div>
                  <div className="veghealth-section-title">Condition ({result.ratedTrees} rated trees)</div>
                  <div className="veghealth-breakdown">
                    <ConditionBar label="Good" count={result.goodCount} total={result.ratedTrees} color="#66bb6a" />
                    <ConditionBar label="Fair" count={result.fairCount} total={result.ratedTrees} color="#ffca28" />
                    <ConditionBar label="Poor" count={result.poorCount} total={result.ratedTrees} color="#ef5350" />
                  </div>
                </div>

                <div>
                  <div className="veghealth-section-title">
                    Species Diversity ({result.distinctSpeciesCount} species, {result.diversityScore}/100)
                  </div>
                  <ul className="veghealth-species-list">
                    {result.topSpecies.map((s) => (
                      <li key={s.species}>
                        <span>{s.species}</span>
                        <span>{s.count}</span>
                      </li>
                    ))}
                    {result.topSpecies.length === 0 && (
                      <li>
                        <span>No species data available</span>
                      </li>
                    )}
                  </ul>
                </div>

                <div className="veghealth-panel__footer">
                  {result.dataSource}
                  <br />
                  Within {result.radiusM}m · {result.totalTrees} trees analyzed
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
