import { useEffect, useState } from "react";
import { DEMO_BUILDING_ID, fetchWellnessSnapshot, WellnessSnapshot } from "./wellnessApi";
import "./GreenWellnessPanel.css";

const RING_RADIUS = 60;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function scoreColor(score: number): string {
  if (score >= 80) return "#66bb6a";
  if (score >= 60) return "#9ccc65";
  if (score >= 40) return "#ffca28";
  return "#ef5350";
}

function scoreLabel(score: number): string {
  if (score >= 80) return "Excellent Urban Environment";
  if (score >= 60) return "Good Urban Environment";
  if (score >= 40) return "Fair Urban Environment";
  return "Needs Improvement";
}

/** Animates a number from 0 up to `target` over `durationMs` — the hero score's 0 -> N count-up. */
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

interface MetricDef {
  key: string;
  icon: string;
  name: string;
  value: string;
  score: number;
  detail: string;
}

function MetricCard({ metric }: { metric: MetricDef }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`wellness-metric ${expanded ? "expanded" : ""}`} onClick={() => setExpanded((v) => !v)}>
      <div className="wellness-metric__row">
        <span className="wellness-metric__icon">{metric.icon}</span>
        <div className="wellness-metric__info">
          <div className="wellness-metric__name">{metric.name}</div>
          <div className="wellness-metric__value">{metric.value}</div>
        </div>
        <span
          className="wellness-metric__badge"
          style={{ background: `${scoreColor(metric.score)}26`, color: scoreColor(metric.score) }}
        >
          {Math.round(metric.score)}
        </span>
        <span className="wellness-metric__chevron">▾</span>
      </div>
      {expanded && <div className="wellness-metric__detail">{metric.detail}</div>}
    </div>
  );
}

function HeroCard({ snapshot }: { snapshot: WellnessSnapshot }) {
  const animated = useCountUp(snapshot.overallScore);
  const dashOffset = RING_CIRCUMFERENCE * (1 - animated / 100);
  const color = scoreColor(snapshot.overallScore);

  return (
    <div className="wellness-hero">
      <div className="wellness-hero__ring-wrap">
        <svg width="140" height="140">
          <circle className="wellness-hero__ring-bg" cx="70" cy="70" r={RING_RADIUS} />
          <circle
            className="wellness-hero__ring-fg"
            cx="70"
            cy="70"
            r={RING_RADIUS}
            stroke={color}
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <div className="wellness-hero__score">
          <span className="wellness-hero__score-num" style={{ color }}>
            {Math.round(animated)}
          </span>
          <span className="wellness-hero__score-max">/ 100</span>
        </div>
      </div>
      <div className="wellness-hero__label" style={{ color }}>
        {scoreLabel(snapshot.overallScore)}
      </div>
      <div className="wellness-hero__sublabel">Green Wellness Score</div>
    </div>
  );
}

function buildMetrics(snapshot: WellnessSnapshot): MetricDef[] {
  const raw = snapshot.rawMetrics;
  return [
    {
      key: "treeCanopy",
      icon: "🌲",
      name: "Tree Canopy",
      value: `${raw.estimatedCanopyCoveragePct.toFixed(0)}%`,
      score: snapshot.treeCanopyScore,
      detail: `Estimated canopy coverage within ${raw.treeCanopyRadiusM}m, from ${raw.treeCount} trees combined across sources — ${raw.nycForestryCount} from NYC's official Forestry inventory (with measured crown size where available) and ${raw.overpassOnlyCount} additional from OpenStreetMap, deduplicated against each other.`,
    },
    {
      key: "noise",
      icon: "🔊",
      name: "Noise",
      value: raw.noiseLevel,
      score: snapshot.noiseScore,
      detail:
        raw.nearestMajorRoadM === null
          ? "No major road found within 300m — estimated to be a quiet location."
          : `Nearest major road is ~${raw.nearestMajorRoadM}m away. This is a distance-based estimate, not a real acoustic measurement.`,
    },
    {
      key: "airQuality",
      icon: "💨",
      name: "Air Quality",
      value: raw.aqi === null ? "Unavailable" : `AQI ${raw.aqi} — ${raw.aqiStatus}`,
      score: snapshot.airQualityScore,
      detail:
        raw.aqi === null
          ? "Live air quality data is currently unavailable for this location."
          : `Current US AQI is ${raw.aqi} (${raw.aqiStatus})${raw.pm2_5 !== null ? `, PM2.5 at ${raw.pm2_5} µg/m³` : ""}. Sourced live from Open-Meteo's air quality API.`,
    },
    {
      key: "heat",
      icon: "🌡️",
      name: "Heat Comfort",
      value: raw.feelsLikeC === null ? "Unavailable" : `${raw.feelsLikeC.toFixed(1)}°C feels like`,
      score: snapshot.heatComfortScore,
      detail:
        raw.feelsLikeC === null
          ? "Live temperature data is currently unavailable for this location."
          : `Currently ${raw.temperatureC?.toFixed(1)}°C, feels like ${raw.feelsLikeC.toFixed(1)}°C — ${
              raw.differenceFromCityAverageC !== null
                ? `${Math.abs(raw.differenceFromCityAverageC).toFixed(1)}°C ${raw.differenceFromCityAverageC <= 0 ? "cooler" : "warmer"} than the city average`
                : "city average unavailable"
            }. Nearby tree canopy is estimated to reduce local temperature by ~${raw.estimatedTreeCoolingC}°C.`,
    },
  ];
}

export function GreenWellnessPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<WellnessSnapshot | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");

  useEffect(() => {
    if (!isOpen || loadState !== "idle") return;
    setLoadState("loading");
    fetchWellnessSnapshot()
      .then((data) => {
        setSnapshot(data);
        setLoadState("loaded");
      })
      .catch(() => setLoadState("error"));
  }, [isOpen, loadState]);

  // Auto-refresh while the panel is open — the backend now always computes
  // Air Quality/Heat Comfort live on every request (never cached, see
  // wellnessAggregatorService.ts), so a plain re-fetch is enough to pick up
  // genuinely current conditions; no forceRefresh needed for this poll
  // (that flag only controls the separately-cached Tree Canopy/Noise
  // tier). Silent — updates the snapshot in place without flashing the
  // loading state, so live numbers just quietly tick over.
  useEffect(() => {
    if (!isOpen || loadState !== "loaded") return;
    const interval = setInterval(() => {
      fetchWellnessSnapshot().then(setSnapshot).catch(() => {
        // A missed poll just means the numbers stay as they were until the next tick — not worth surfacing as an error.
      });
    }, 60000);
    return () => clearInterval(interval);
  }, [isOpen, loadState]);

  function retry() {
    setLoadState("idle");
  }

  const [isRefreshing, setIsRefreshing] = useState(false);
  async function refresh() {
    setIsRefreshing(true);
    try {
      const data = await fetchWellnessSnapshot(DEMO_BUILDING_ID, true);
      setSnapshot(data);
    } catch {
      // Keep showing the last good snapshot rather than blanking the panel over a failed refresh.
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`wellness-toggle ${isOpen ? "active" : ""}`}
        onClick={() => setIsOpen((v) => !v)}
        title="Green Wellness Score"
        aria-label="Green Wellness Score"
      >
        🌿
      </button>

      {isOpen && (
        <div className="wellness-panel" role="dialog" aria-label="Green Wellness Score">
          <div className="wellness-panel__header">
            <span className="wellness-panel__title">Green Wellness</span>
            <div className="wellness-panel__header-actions">
              {loadState === "loaded" && (
                <button
                  type="button"
                  className="wellness-panel__refresh"
                  onClick={refresh}
                  disabled={isRefreshing}
                  title="Recompute now (bypasses the 30-day cache)"
                >
                  {isRefreshing ? "⏳" : "↻"}
                </button>
              )}
              <button
                type="button"
                className="wellness-panel__close"
                onClick={() => setIsOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
          </div>

          <div className="wellness-panel__body">
            {loadState === "loading" && <div className="wellness-panel__loading">Computing wellness score…</div>}

            {loadState === "error" && (
              <div className="wellness-panel__error">
                Couldn't load the wellness score.
                <div>
                  <button type="button" className="wellness-panel__retry" onClick={retry}>
                    Retry
                  </button>
                </div>
              </div>
            )}

            {loadState === "loaded" && snapshot && (
              <>
                <HeroCard snapshot={snapshot} />

                <div>
                  <div className="wellness-section-title">Metrics</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {buildMetrics(snapshot).map((metric) => (
                      <MetricCard key={metric.key} metric={metric} />
                    ))}
                  </div>
                </div>

                <div className="wellness-panel__footer">
                  🟢 Air Quality &amp; Heat Comfort refresh live, every minute
                  <br />
                  Tree Canopy &amp; Noise {snapshot.cacheHit ? "cached (updates daily)" : "freshly checked"}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
