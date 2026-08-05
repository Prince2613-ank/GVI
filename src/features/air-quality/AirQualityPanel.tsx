import { useEffect, useState } from "react";
import { fetchWellnessSnapshot, WellnessSnapshot } from "../wellness/wellnessApi";
import "./AirQualityPanel.css";

const POLL_MS = 60000;

function aqiColor(aqi: number | null): string {
  if (aqi === null) return "#9aa4ad";
  if (aqi <= 50) return "#66bb6a";
  if (aqi <= 100) return "#ffca28";
  if (aqi <= 150) return "#ff8a65";
  return "#ef5350";
}

export function AirQualityPanel() {
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
  const color = aqiColor(raw?.aqi ?? null);

  return (
    <>
      <button
        type="button"
        className={`aqi-toggle ${isOpen ? "active" : ""}`}
        onClick={() => setIsOpen((v) => !v)}
        title="Air Quality"
        aria-label="Air Quality"
      >
        💨
        {raw?.aqi != null && (
          <span className="aqi-toggle__badge" style={{ color }}>
            {raw.aqi}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="aqi-panel" role="dialog" aria-label="Air Quality">
          <div className="aqi-panel__header">
            <span className="aqi-panel__title">Air Quality</span>
            <button type="button" className="aqi-panel__close" onClick={() => setIsOpen(false)} aria-label="Close">
              ✕
            </button>
          </div>

          <div className="aqi-panel__body">
            {loadState === "loading" && <div className="aqi-panel__loading">Checking current air quality…</div>}

            {loadState === "error" && (
              <div className="aqi-panel__error">
                Couldn't load air quality data.
                <div>
                  <button type="button" className="aqi-panel__retry" onClick={retry}>
                    Retry
                  </button>
                </div>
              </div>
            )}

            {loadState === "loaded" && raw && (
              <>
                <div className="aqi-hero" style={{ borderColor: `${color}55` }}>
                  <div className="aqi-hero__value" style={{ color }}>
                    {raw.aqi ?? "—"}
                  </div>
                  <div className="aqi-hero__sublabel">US AQI</div>
                  <div className="aqi-hero__label" style={{ color }}>
                    {raw.aqiStatus ?? "Unavailable"}
                  </div>
                </div>

                <div className="aqi-stats">
                  <div className="aqi-stat">
                    <span className="aqi-stat__label">PM2.5</span>
                    <span className="aqi-stat__value">{raw.pm2_5 !== null ? `${raw.pm2_5} µg/m³` : "—"}</span>
                  </div>
                  <div className="aqi-stat">
                    <span className="aqi-stat__label">Source</span>
                    <span className="aqi-stat__value">
                      {raw.airQualitySource === "airnow" ? "EPA AirNow" : raw.airQualitySource === "open-meteo" ? "Open-Meteo" : "Unavailable"}
                    </span>
                  </div>
                </div>

                <div className="aqi-panel__footer">🟢 Live — updates automatically every minute</div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
