import * as Cesium from "cesium";
import { useEffect, useMemo, useState } from "react";
import { CardinalDirection, CARDINAL_DIRECTIONS, DEFAULT_LOCATION } from "../../utils/constants";
import { INITIAL_BUILDING } from "../../config/building";
import { computeSunPosition, currentHourInNewYork, findSunriseSunset, julianDateAtHour } from "./sunPosition";
import { computeWindowSunlight, lightQualityForElevation, windowHeadingDeg } from "./windowSunlight";
import { applySunlightEffects, restoreViewer } from "./sunlightEffects";
import { analyzeCanopyLightFilter, CanopyLightResult } from "./canopyLightAnalysis";
import { fetchTodayWeather, irradianceFactor, TodayWeather, weatherLabel } from "./weather";
import { fetchWellnessSnapshot, WellnessSnapshot } from "../wellness/wellnessApi";
import { VegetationLayer } from "../../gis/VegetationLayer";
import "./SunlightAnalysisPanel.css";

const AQI_POLL_MS = 60000;

const DAY_START_HOUR = 0;
const DAY_END_HOUR = 24;
const SAMPLE_STEP_HOUR = 0.5;
const TICK_MS = 250;

interface SunlightAnalysisPanelProps {
  viewer: Cesium.Viewer | null;
  /** The actual tileset rendering the surrounding white city-block masses — needed to tint them for day/night, since 3D Tiles don't pick up scene.light shading the way Entity polygons do. */
  osmBuildings: Cesium.Cesium3DTileset | null;
  /** Needed to tint distant (billboard-tier) trees for day/night — see TreeRenderer.setNightTint for why only that tier needs it explicitly. */
  vegetationLayer: VegetationLayer | null;
}

function formatHour(hour: number): string {
  const h = Math.floor(hour) % 24;
  const m = Math.round((hour - Math.floor(hour)) * 60);
  const period = h < 12 ? "AM" : "PM";
  const displayH = h % 12 === 0 ? 12 : h % 12;
  return `${displayH.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")} ${period}`;
}

function aqiColor(aqi: number | null): string {
  if (aqi === null) return "#9aa4ad";
  if (aqi <= 50) return "#66bb6a";
  if (aqi <= 100) return "#ffca28";
  if (aqi <= 150) return "#ff8a65";
  return "#ef5350";
}

function intensityColor(pct: number): string {
  if (pct <= 0) return "#3b5b8c";
  if (pct < 25) return "#66bb6a";
  if (pct < 50) return "#d4c545";
  if (pct < 75) return "#ff9a3d";
  return "#ef5350";
}

/** One sample of the day's sunlight curve for the currently selected orientation. */
interface DaySample {
  hour: number;
  intensityPct: number;
}

/**
 * Geometric intensity (sun-vs-window angle) alone assumes a clear sky —
 * multiplying by each hour's real forecasted weather (once loaded) is what
 * keeps this curve, and everything derived from it (duration, peak time),
 * consistent with what the Weather row actually says instead of silently
 * assuming cloudless conditions all day.
 */
function useDayCurve(side: CardinalDirection, weather: TodayWeather | null): DaySample[] {
  return useMemo(() => {
    const heading = windowHeadingDeg(INITIAL_BUILDING.rotationRad, side);
    const samples: DaySample[] = [];
    for (let hour = DAY_START_HOUR; hour <= DAY_END_HOUR; hour += SAMPLE_STEP_HOUR) {
      const sun = computeSunPosition(julianDateAtHour(hour), DEFAULT_LOCATION.latitude, DEFAULT_LOCATION.longitude);
      const result = computeWindowSunlight(sun, heading);
      const hourWeather = weather?.hourly[Math.round(hour) % 24];
      const factor = hourWeather ? irradianceFactor(hourWeather.irradianceWm2) : 1;
      samples.push({ hour, intensityPct: Math.round(result.intensityPct * factor) });
    }
    return samples;
  }, [side, weather]);
}

function SunPathCompass({
  azimuthDeg,
  elevationDeg,
  timeLabel,
}: {
  azimuthDeg: number;
  elevationDeg: number;
  timeLabel: string;
}) {
  const size = 180;
  const center = size / 2;
  const maxR = center - 18;
  // Polar sun-path projection: overhead sun (elevation 90) plots at the
  // center, a sun on the horizon (elevation 0) plots at the rim — the
  // standard sun-path-diagram convention. Kept clear of the very middle so
  // it never overlaps the live time label plotted there.
  const minR = 30;
  const r = minR + (maxR - minR) * (1 - Math.max(0, Math.min(90, elevationDeg)) / 90);
  const angleRad = ((azimuthDeg - 90) * Math.PI) / 180; // azimuth 0=N plotted at top
  const sunX = center + r * Math.cos(angleRad);
  const sunY = center + r * Math.sin(angleRad);
  const visible = elevationDeg > 0;

  return (
    <svg width={size} height={size} className="sun-compass">
      <circle cx={center} cy={center} r={maxR} className="sun-compass__ring" />
      <circle cx={center} cy={center} r={maxR * 0.66} className="sun-compass__ring sun-compass__ring--inner" />
      <circle cx={center} cy={center} r={maxR * 0.33} className="sun-compass__ring sun-compass__ring--inner" />
      <text x={center} y={16} className="sun-compass__label">N</text>
      <text x={size - 10} y={center + 4} className="sun-compass__label">E</text>
      <text x={center} y={size - 6} className="sun-compass__label">S</text>
      <text x={10} y={center + 4} className="sun-compass__label">W</text>
      <text x={center} y={center + 5} className="sun-compass__time">{timeLabel}</text>
      {visible && <circle cx={sunX} cy={sunY} r={8} className="sun-compass__sun" />}
    </svg>
  );
}

interface FacadeReading {
  side: CardinalDirection;
  intensityPct: number;
}

/**
 * Live intensity for all four facades at once, at the current sun position
 * — this is what makes "sun's in the East, so East windows are brightest
 * right now" an explicit, visible comparison, and is now the *only* way
 * orientation is chosen: the rest of the panel auto-follows whichever
 * facade this identifies as brightest, rather than a separate manual
 * N/S/E/W picker that just duplicated the same information.
 */
function AllFacadesRow({ readings, brightestSide }: { readings: FacadeReading[]; brightestSide: CardinalDirection | null }) {
  return (
    <div>
      <div className="sun-section-title">All Facades Right Now{brightestSide ? ` — ${brightestSide} brightest` : ""}</div>
      <div className="sun-facades-row">
        {readings.map((r) => (
          <div key={r.side} className={`sun-facade-chip ${r.side === brightestSide ? "brightest" : ""}`}>
            <span className="sun-facade-chip__label">{r.side.slice(0, 1)}</span>
            <span className="sun-facade-chip__value">{r.intensityPct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SunlightAnalysisPanel({ viewer, osmBuildings, vegetationLayer }: SunlightAnalysisPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [hour, setHour] = useState(() => currentHourInNewYork());
  const [isPlaying, setIsPlaying] = useState(false);
  // Separate from isPlaying on purpose: Pause only freezes the clock, it
  // doesn't revert the cinematic effect — the scene should stay exactly as
  // it looked the moment you paused. Only Stop actually ends the session
  // and reverts the lighting/shadows back to normal.
  const [isRunning, setIsRunning] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const [canopyLightResult, setCanopyLightResult] = useState<CanopyLightResult | null>(null);
  const [canopyLightState, setCanopyLightState] = useState<"idle" | "analyzing" | "done" | "error">("idle");
  const [weather, setWeather] = useState<TodayWeather | null>(null);
  const [weatherState, setWeatherState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [wellness, setWellness] = useState<WellnessSnapshot | null>(null);
  const [wellnessState, setWellnessState] = useState<"idle" | "loading" | "loaded" | "error">("idle");

  // Opening the panel snaps the timeline to the real current New York hour
  // (rather than staying wherever it was last left) and fetches today's
  // real hourly weather forecast for this location, so the first thing
  // shown is what's actually happening right now, not a stale time or an
  // assumed clear sky.
  useEffect(() => {
    if (isOpen) setHour(currentHourInNewYork());
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) setWeatherState("idle"); // refetch fresh weather every time the panel opens
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || weatherState !== "idle") return;
    setWeatherState("loading");
    fetchTodayWeather(DEFAULT_LOCATION.latitude, DEFAULT_LOCATION.longitude)
      .then((data) => {
        setWeather(data);
        setWeatherState("loaded");
      })
      .catch(() => setWeatherState("error"));
  }, [isOpen, weatherState]);

  // Real live Air Quality — same backend/AirNow-or-Open-Meteo source the
  // old standalone AQI icon used, now folded into this panel instead
  // (there's no hourly AQI forecast API in play, so this is always "right
  // now," not tied to whatever hour the timeline is scrubbed to).
  useEffect(() => {
    if (isOpen) setWellnessState("idle");
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || wellnessState !== "idle") return;
    setWellnessState("loading");
    fetchWellnessSnapshot()
      .then((data) => {
        setWellness(data);
        setWellnessState("loaded");
      })
      .catch(() => setWellnessState("error"));
  }, [isOpen, wellnessState]);

  useEffect(() => {
    if (!isOpen || wellnessState !== "loaded") return;
    const interval = setInterval(() => {
      fetchWellnessSnapshot().then(setWellness).catch(() => {});
    }, AQI_POLL_MS);
    return () => clearInterval(interval);
  }, [isOpen, wellnessState]);

  // Always plays at a fixed 1x — no speed picker to fiddle with.
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setHour((h) => {
        const next = h + SAMPLE_STEP_HOUR / 4;
        return next > DAY_END_HOUR ? DAY_START_HOUR : next;
      });
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [isPlaying]);

  const sun = useMemo(
    () => computeSunPosition(julianDateAtHour(hour), DEFAULT_LOCATION.latitude, DEFAULT_LOCATION.longitude),
    [hour]
  );

  const currentWeather = weather?.hourly[Math.round(hour) % 24] ?? null;
  // Driven by real forecasted solar irradiance (W/m²) for the hour being
  // viewed, not a cloud-cover guess — irradiance already folds in cloud
  // cover, sun angle, and atmosphere together, so it's a more accurate
  // "how much real sun is hitting the ground right now" signal. Falls back
  // to the geometric elevation-only estimate only while weather hasn't
  // loaded yet. This is what makes every "is the sun actually reaching this
  // window" figure below consistent with the Weather row instead of both
  // silently assuming a clear sky.
  const weatherFactor = currentWeather ? irradianceFactor(currentWeather.irradianceWm2) : sun.elevationDeg > 0 ? 1 : 0;

  // Orientation auto-follows the sun instead of a manual N/S/E/W picker —
  // "side" is always whichever real facade is currently brightest (after
  // real weather is applied), falling back to South (arbitrary but stable)
  // when nothing is actually lit right now.
  const facadeReadings: FacadeReading[] = useMemo(
    () =>
      CARDINAL_DIRECTIONS.map((s) => {
        const h = windowHeadingDeg(INITIAL_BUILDING.rotationRad, s);
        const geometricPct = computeWindowSunlight(sun, h).intensityPct;
        return { side: s, intensityPct: Math.round(geometricPct * weatherFactor) };
      }),
    [sun, weatherFactor]
  );
  const brightestFacade = useMemo(
    () => facadeReadings.reduce((best, r) => (r.intensityPct > best.intensityPct ? r : best), facadeReadings[0]),
    [facadeReadings]
  );
  const side: CardinalDirection = brightestFacade.intensityPct > 0 ? brightestFacade.side : "South";

  const heading = useMemo(() => windowHeadingDeg(INITIAL_BUILDING.rotationRad, side), [side]);
  // Real, weather-adjusted reading for the selected facade — under true
  // 100% cloud cover there is no direct beam sunlight at all (only diffuse
  // skylight), so "Direct Sunlight" now correctly flips to NO in that case
  // rather than reporting the clear-sky-only geometric result.
  const sunlight = useMemo(() => {
    const geometric = computeWindowSunlight(sun, heading);
    const intensityPct = Math.round(geometric.intensityPct * weatherFactor);
    return { isDirectSunlight: intensityPct > 0, intensityPct };
  }, [sun, heading, weatherFactor]);
  const lightQuality = useMemo(() => {
    // Under heavy cloud, light character is dominated by diffusion, not the
    // sun's elevation — "Harsh midday sun" isn't real if it's fully overcast.
    if (sun.elevationDeg > 0 && weatherFactor < 0.15) return "Diffuse";
    return lightQualityForElevation(sun.elevationDeg);
  }, [sun.elevationDeg, weatherFactor]);
  const daySamples = useDayCurve(side, weather);

  // Real sunrise/sunset for today, found by bisecting this module's own
  // elevation function — not looked up from an averaged table. Stable for
  // the life of the panel (today's sun doesn't move), so computed once.
  const sunriseSunset = useMemo(
    () =>
      findSunriseSunset(
        (h) => computeSunPosition(julianDateAtHour(h), DEFAULT_LOCATION.latitude, DEFAULT_LOCATION.longitude).elevationDeg
      ),
    []
  );

  const durationHours = useMemo(
    () => daySamples.filter((s) => s.intensityPct > 0).length * SAMPLE_STEP_HOUR,
    [daySamples]
  );
  const peakSample = useMemo(
    () => daySamples.reduce((best, s) => (s.intensityPct > best.intensityPct ? s : best), daySamples[0]),
    [daySamples]
  );

  function startPause() {
    setIsPlaying((p) => !p);
    setIsRunning(true); // starting fresh or resuming — either way a session is (still) active
  }

  function stop() {
    setIsPlaying(false);
    setIsRunning(false);
    // A canopy-light reading only means something for the sun position it
    // was captured under — once the session stops (and the real lighting
    // reverts), that reading is stale.
    setCanopyLightResult(null);
    setCanopyLightState("idle");
  }

  function reset() {
    setIsPlaying(false);
    setHour(currentHourInNewYork()); // back to real "now," not a fixed demo hour
  }

  async function analyzeCanopyLight() {
    if (!viewer) return;
    setCanopyLightState("analyzing");
    try {
      const result = await analyzeCanopyLightFilter(viewer);
      setCanopyLightResult(result);
      setCanopyLightState("done");
    } catch {
      setCanopyLightState("error");
    }
  }

  // Real, reversible cinematic rendering — applies actual Cesium
  // shadows/lighting/post-process stages driven by this exact sun vector.
  // Tied to `isRunning`, not `isPlaying`: pausing only freezes the clock —
  // the scene should stay exactly as it looked at that moment — while Stop
  // is what actually ends the session and reverts the lighting/shadows.
  // Deliberately NOT gated on `isOpen` either: closing the panel doesn't
  // touch it (with a confirmation on close if still running, see below).
  // See sunlightEffects.ts for why it's still off-by-default-reversible
  // rather than a permanent global setting (it would otherwise affect GVI
  // capture).
  useEffect(() => {
    if (!viewer || !isRunning) return;
    applySunlightEffects(viewer, sun, sun.directionEcef, weatherFactor, osmBuildings, vegetationLayer);
    return () => restoreViewer(viewer, osmBuildings, vegetationLayer);
  }, [viewer, isRunning, sun, weatherFactor, osmBuildings, vegetationLayer]);

  return (
    <>
      <button
        type="button"
        className={`sun-toggle ${isOpen ? "active" : ""} ${isRunning ? "effect-on" : ""}`}
        onClick={() =>
          setIsOpen((v) => {
            const next = !v;
            if (next && window.innerWidth <= 640) window.dispatchEvent(new Event("balcony-panel:close"));
            return next;
          })
        }
        title={isRunning ? "Sunlight Analysis (running)" : "Sunlight Analysis"}
        aria-label="Sunlight Analysis"
      >
        ☀️
      </button>

      {isOpen && (
        <div className="sun-panel" role="dialog" aria-label="Sunlight Analysis">
          <div className="sun-panel__header">
            <span className="sun-panel__title">☀️ Sunlight Analysis</span>
            <button
              type="button"
              className="sun-panel__close"
              onClick={() => (isRunning ? setShowCloseConfirm(true) : setIsOpen(false))}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          {showCloseConfirm && (
            <div className="sun-close-confirm-backdrop">
              <div className="sun-close-confirm" role="alertdialog" aria-label="Keep analysis running?">
                <div className="sun-close-confirm__title">Keep analysis running?</div>
                <div className="sun-close-confirm__body">
                  The simulation and its real sun-driven shadows/lighting are currently active. Continue running
                  them after closing this panel, or stop?
                </div>
                <div className="sun-close-confirm__actions">
                  <button
                    type="button"
                    className="sun-close-confirm__btn"
                    onClick={() => {
                      stop();
                      setShowCloseConfirm(false);
                      setIsOpen(false);
                    }}
                  >
                    Stop &amp; Close
                  </button>
                  <button
                    type="button"
                    className="sun-close-confirm__btn primary"
                    onClick={() => {
                      setShowCloseConfirm(false);
                      setIsOpen(false);
                    }}
                  >
                    Continue Running
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="sun-panel__body">
            <div className="sun-time">
              <div className="sun-compass-wrap">
                <SunPathCompass azimuthDeg={sun.azimuthDeg} elevationDeg={sun.elevationDeg} timeLabel={formatHour(hour)} />
              </div>
              <div className="sun-time__row">
                <button type="button" className="sun-start-btn" onClick={startPause}>
                  {isPlaying ? "⏸ Pause Analysis" : "▶ Start Analysis"}
                </button>
                <button
                  type="button"
                  onClick={stop}
                  className="sun-stop-btn"
                  title="Stop (ends the session and reverts lighting)"
                  disabled={!isRunning}
                >
                  <span className="sun-stop-btn__icon">⏹</span>
                  <span className="sun-stop-btn__label">Stop</span>
                </button>
                <button type="button" onClick={reset} className="sun-btn" title="Reset to now">
                  ↺
                </button>
              </div>
            </div>

            <AllFacadesRow readings={facadeReadings} brightestSide={brightestFacade.intensityPct > 0 ? brightestFacade.side : null} />

            <div className="sun-info">
              <div className="sun-info__row">
                <span>Sunrise / Sunset</span>
                <span className="sun-info__value">
                  {sunriseSunset.sunriseHour !== null ? formatHour(sunriseSunset.sunriseHour) : "—"} –{" "}
                  {sunriseSunset.sunsetHour !== null ? formatHour(sunriseSunset.sunsetHour) : "—"}
                </span>
              </div>
              <div className="sun-info__row">
                <span>Weather</span>
                <span className="sun-info__value">
                  {weatherState === "loading" && "Loading…"}
                  {weatherState === "error" && "Unavailable"}
                  {weatherState === "loaded" && currentWeather && (
                    <>
                      {weatherLabel(currentWeather.weatherCode)} · {currentWeather.cloudCoverPct}% cloud
                    </>
                  )}
                </span>
              </div>
              <div className="sun-info__row">
                <span>Temperature</span>
                <span className="sun-info__value">
                  {currentWeather
                    ? `${currentWeather.temperatureC.toFixed(1)}°C (feels ${currentWeather.feelsLikeC.toFixed(1)}°C)`
                    : "—"}
                </span>
              </div>
              <div className="sun-info__row">
                <span>Solar Irradiance</span>
                <span className="sun-info__value">{currentWeather ? `${Math.round(currentWeather.irradianceWm2)} W/m²` : "—"}</span>
              </div>
              <div className="sun-info__row">
                <span>Air Quality (live)</span>
                <span className="sun-info__value" style={{ color: aqiColor(wellness?.rawMetrics.aqi ?? null) }}>
                  {wellnessState === "loading" && "Loading…"}
                  {wellnessState === "error" && "Unavailable"}
                  {wellnessState === "loaded" && wellness && (
                    <>
                      {wellness.rawMetrics.aqi !== null ? `AQI ${wellness.rawMetrics.aqi}` : "—"} · {wellness.rawMetrics.aqiStatus ?? "—"}
                    </>
                  )}
                </span>
              </div>
              <div className="sun-info__row">
                <span>Orientation</span>
                <span className="sun-info__value">{side}</span>
              </div>
              <div className="sun-info__row">
                <span>Sun Elevation</span>
                <span className="sun-info__value">{sun.elevationDeg.toFixed(1)}°</span>
              </div>
              <div className="sun-info__row">
                <span>Sun Azimuth</span>
                <span className="sun-info__value">{sun.azimuthDeg.toFixed(1)}°</span>
              </div>
              <div className="sun-info__row">
                <span>Light Quality</span>
                <span className={`sun-info__value sun-quality-${lightQuality.toLowerCase()}`}>{lightQuality}</span>
              </div>
              <div className="sun-info__row">
                <span>Direct Sunlight</span>
                <span className={`sun-info__badge ${sunlight.isDirectSunlight ? "yes" : "no"}`}>
                  {sunlight.isDirectSunlight ? "YES" : "NO"}
                </span>
              </div>
              <div className="sun-info__row sun-info__row--stack">
                <span>Sunlight Intensity</span>
                <span className="sun-info__value">{sunlight.intensityPct}%</span>
              </div>
              <div className="sun-intensity-track">
                <div
                  className="sun-intensity-fill"
                  style={{ width: `${sunlight.intensityPct}%`, background: intensityColor(sunlight.intensityPct) }}
                />
              </div>
              <div className="sun-info__row">
                <span>Est. Sunlight Duration Today</span>
                <span className="sun-info__value">{durationHours.toFixed(1)}h</span>
              </div>
              <div className="sun-info__row">
                <span>Peak Sunlight Time</span>
                <span className="sun-info__value">{peakSample ? formatHour(peakSample.hour) : "—"}</span>
              </div>
            </div>

            <div>
              <div className="sun-section-title">Canopy Light Filter (current view)</div>
              {!isRunning && (
                <div className="sun-canopy__hint">Start Analysis to enable — needs real sun/shadow rendering to read.</div>
              )}
              {isRunning && canopyLightState !== "done" && (
                <button
                  type="button"
                  className="sun-canopy-btn"
                  onClick={analyzeCanopyLight}
                  disabled={canopyLightState === "analyzing"}
                >
                  {canopyLightState === "analyzing" ? "Reading current view…" : "🌳 Analyze Canopy Light Filter"}
                </button>
              )}
              {canopyLightState === "error" && <div className="sun-canopy__hint">Couldn't read the view — try again.</div>}
              {canopyLightState === "done" && canopyLightResult && (
                <div className="sun-canopy-result">
                  <div className="sun-canopy-bar">
                    <div
                      className="sun-canopy-bar__seg canopy"
                      style={{ width: `${canopyLightResult.canopyFilteredPct}%` }}
                      title={`Canopy-filtered: ${canopyLightResult.canopyFilteredPct}%`}
                    />
                    <div
                      className="sun-canopy-bar__seg harsh"
                      style={{ width: `${canopyLightResult.harshPct}%` }}
                      title={`Harsh/hardscape: ${canopyLightResult.harshPct}%`}
                    />
                    <div
                      className="sun-canopy-bar__seg shadow"
                      style={{ width: `${canopyLightResult.shadowPct}%` }}
                      title={`Shadow: ${canopyLightResult.shadowPct}%`}
                    />
                  </div>
                  <div className="sun-canopy-legend">
                    <span><i className="dot canopy" />Canopy-filtered {canopyLightResult.canopyFilteredPct}%</span>
                    <span><i className="dot harsh" />Harsh/hardscape {canopyLightResult.harshPct}%</span>
                    <span><i className="dot shadow" />Shadow {canopyLightResult.shadowPct}%</span>
                  </div>
                  <button type="button" className="sun-canopy-btn secondary" onClick={analyzeCanopyLight}>
                    ↻ Re-analyze
                  </button>
                </div>
              )}
            </div>

          </div>
        </div>
      )}
    </>
  );
}
