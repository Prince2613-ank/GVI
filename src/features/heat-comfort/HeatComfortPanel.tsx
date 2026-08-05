import { useEffect, useState } from "react";
import { fetchWellnessSnapshot, WellnessSnapshot } from "../wellness/wellnessApi";
import "./HeatComfortPanel.css";

const POLL_MS = 60000;

function comfortColor(score: number): string {
  if (score >= 80) return "#66bb6a";
  if (score >= 55) return "#ffca28";
  return "#ef5350";
}

function comfortLabel(score: number): string {
  if (score >= 80) return "Comfortable";
  if (score >= 55) return "Mild Discomfort";
  return "Uncomfortable";
}

export function HeatComfortPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<WellnessSnapshot | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");

  // Fetches unconditionally (not gated on isOpen) so the icon's badge shows
  // a live reading even before the panel is ever opened.
  useEffect(() => {
    if (loadState !== "idle") return;
    setLoadState("loading");
    fetchWellnessSnapshot()
      .then((data) => {
        setSnapshot(data);
        setLoadState("loaded");
      })
      .catch(() => setLoadState("error"));
  }, [loadState]);

  useEffect(() => {
    if (loadState !== "loaded") return;
    const interval = setInterval(() => {
      fetchWellnessSnapshot().then(setSnapshot).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [loadState]);

  function retry() {
    setLoadState("idle");
  }

  const raw = snapshot?.rawMetrics;
  const score = snapshot?.heatComfortScore ?? 0;
  const color = comfortColor(score);
  const badgeTemp = raw?.feelsLikeC ?? null;

  return (
    <>
      <button
        type="button"
        className={`heat-toggle ${isOpen ? "active" : ""}`}
        onClick={() => setIsOpen((v) => !v)}
        title="Heat Comfort"
        aria-label="Heat Comfort"
      >
        🌡️
        {badgeTemp !== null && (
          <span className="heat-toggle__badge" style={{ color }}>
            {Math.round(badgeTemp)}°
          </span>
        )}
      </button>

      {isOpen && (
        <div className="heat-panel" role="dialog" aria-label="Heat Comfort">
          <div className="heat-panel__header">
            <span className="heat-panel__title">Heat Comfort</span>
            <button type="button" className="heat-panel__close" onClick={() => setIsOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>

          <div className="heat-panel__body">
            {loadState === "loading" && <div className="heat-panel__loading">Checking current conditions…</div>}

            {loadState === "error" && (
              <div className="heat-panel__error">
                Couldn't load heat comfort data.
                <div>
                  <button type="button" className="heat-panel__retry" onClick={retry}>
                    Retry
                  </button>
                </div>
              </div>
            )}

            {loadState === "loaded" && raw && (
              <>
                <div className="heat-hero" style={{ borderColor: `${color}55` }}>
                  <div className="heat-hero__temp" style={{ color }}>
                    {raw.feelsLikeC === null ? "—" : `${raw.feelsLikeC.toFixed(1)}°C`}
                  </div>
                  <div className="heat-hero__sublabel">Feels like</div>
                  <div className="heat-hero__label" style={{ color }}>
                    {comfortLabel(score)}
                  </div>
                </div>

                <div className="heat-stats">
                  <div className="heat-stat">
                    <span className="heat-stat__label">Actual Temp</span>
                    <span className="heat-stat__value">{raw.temperatureC?.toFixed(1) ?? "—"}°C</span>
                  </div>
                  <div className="heat-stat">
                    <span className="heat-stat__label">City Average</span>
                    <span className="heat-stat__value">{raw.cityAverageTemperatureC?.toFixed(1) ?? "—"}°C</span>
                  </div>
                  <div className="heat-stat">
                    <span className="heat-stat__label">Vs. City</span>
                    <span className="heat-stat__value">
                      {raw.differenceFromCityAverageC === null
                        ? "—"
                        : `${raw.differenceFromCityAverageC <= 0 ? "" : "+"}${raw.differenceFromCityAverageC.toFixed(1)}°C`}
                    </span>
                  </div>
                  <div className="heat-stat">
                    <span className="heat-stat__label">Tree Cooling</span>
                    <span className="heat-stat__value">-{raw.estimatedTreeCoolingC.toFixed(1)}°C</span>
                  </div>
                </div>

                <div className="heat-panel__footer">🟢 Live — updates automatically every minute</div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
