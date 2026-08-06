// Real live/forecast weather — Open-Meteo, the same keyless provider the
// backend's heatService.ts already uses (see that file's comment for why:
// zero signup, genuinely current data). Requesting `timezone=America/New_York`
// makes Open-Meteo return the hourly arrays already indexed to NY local
// hours (0-23), so picking today's array at whatever hour the timeline is
// scrubbed to — not just "right now" — lines up directly, no extra
// conversion needed.
//
// `shortwave_radiation` (W/m²) is real forecasted solar irradiance at the
// surface — it already folds in cloud cover, sun angle, and atmospheric
// scattering, so it's a strictly more accurate "how much real sun is
// actually reaching the ground right now" signal than deriving one from
// cloud-cover percentage alone. 1000 W/m² is the standard "full sun"
// reference the solar-power industry uses (STC, Standard Test Conditions)
// — used here as the normalization ceiling for how strongly this hour's
// real irradiance should drive the cinematic sun effect.

const WEATHER_API_URL = "https://api.open-meteo.com/v1/forecast";
const HOURLY_PARAMS = "temperature_2m,apparent_temperature,cloud_cover,weather_code,shortwave_radiation";
const FULL_SUN_IRRADIANCE_WM2 = 1000; // STC reference

export interface HourlyWeather {
  temperatureC: number;
  feelsLikeC: number;
  cloudCoverPct: number;
  weatherCode: number;
  /** Real forecasted solar irradiance at the surface, W/m². */
  irradianceWm2: number;
}

export interface TodayWeather {
  hourly: HourlyWeather[]; // index 0-23, NY local hour
}

/** WMO weather codes (the standard Open-Meteo reports) collapsed to a short label. */
export function weatherLabel(code: number): string {
  if (code === 0) return "Clear Sky";
  if (code <= 2) return "Partly Cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain Showers";
  if (code >= 95) return "Thunderstorm";
  return "Unknown";
}

/** 0-1, how close this hour's real irradiance is to "full sun" (1000 W/m², the solar-industry STC reference). */
export function irradianceFactor(irradianceWm2: number): number {
  return Math.max(0, Math.min(1, irradianceWm2 / FULL_SUN_IRRADIANCE_WM2));
}

export async function fetchTodayWeather(latitude: number, longitude: number): Promise<TodayWeather> {
  const url = `${WEATHER_API_URL}?latitude=${latitude}&longitude=${longitude}&hourly=${HOURLY_PARAMS}&timezone=America%2FNew_York&forecast_days=1`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo weather API returned ${response.status}`);
  const data = (await response.json()) as {
    hourly?: {
      temperature_2m?: number[];
      apparent_temperature?: number[];
      cloud_cover?: number[];
      weather_code?: number[];
      shortwave_radiation?: number[];
    };
  };
  const h = data.hourly ?? {};

  const hourly: HourlyWeather[] = Array.from({ length: 24 }, (_, i) => ({
    temperatureC: h.temperature_2m?.[i] ?? 0,
    feelsLikeC: h.apparent_temperature?.[i] ?? 0,
    cloudCoverPct: h.cloud_cover?.[i] ?? 0,
    weatherCode: h.weather_code?.[i] ?? 0,
    irradianceWm2: h.shortwave_radiation?.[i] ?? 0,
  }));

  return { hourly };
}
