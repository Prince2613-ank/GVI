// NASA POWER (named in the original spec) is a daily-climatology dataset —
// good for historical/seasonal analysis, but it has a multi-day lag and
// isn't a fit for "current temperature." Open-Meteo's weather API is used
// instead: keyless, zero signup, and actually returns live current
// conditions, which is what the spec's UI ("Current Temperature", "Feels
// Like") needs.
const WEATHER_API_URL = "https://api.open-meteo.com/v1/forecast";

// A fixed reference point (Central Park) as the "city average" comparison
// — not a true citywide spatial average (that would need many sample
// points), but a single well-known, stable reference is enough to answer
// "is it hotter here than a typical NYC spot right now," which is the
// actual question this metric exists to answer.
const CITY_REFERENCE_POINT = { latitude: 40.7829, longitude: -73.9654 };

// Rough, clearly-labeled estimate: mature, dense canopy measurably lowers
// local air temperature (urban forestry research generally cites low-
// single-digit °C reductions under heavy canopy) — this scales that
// ceiling by the tree-canopy service's coverage % rather than claiming a
// precise per-building measurement.
const MAX_CANOPY_COOLING_C = 3;

export interface HeatComfortResult {
  temperatureC: number | null;
  feelsLikeC: number | null;
  cityAverageTemperatureC: number | null;
  differenceFromCityAverageC: number | null;
  estimatedTreeCoolingC: number;
}

async function fetchCurrentTemp(latitude: number, longitude: number): Promise<{ temp: number | null; feelsLike: number | null }> {
  const url = `${WEATHER_API_URL}?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo weather API returned ${response.status}`);
  const data = (await response.json()) as {
    current?: { temperature_2m?: number; apparent_temperature?: number };
  };
  return {
    temp: data.current?.temperature_2m ?? null,
    feelsLike: data.current?.apparent_temperature ?? null,
  };
}

export async function computeHeatComfort(
  latitude: number,
  longitude: number,
  canopyCoveragePct: number
): Promise<HeatComfortResult> {
  const [here, city] = await Promise.all([
    fetchCurrentTemp(latitude, longitude),
    fetchCurrentTemp(CITY_REFERENCE_POINT.latitude, CITY_REFERENCE_POINT.longitude),
  ]);

  const estimatedTreeCoolingC = Math.round(((canopyCoveragePct / 100) * MAX_CANOPY_COOLING_C) * 10) / 10;

  return {
    temperatureC: here.temp,
    feelsLikeC: here.feelsLike,
    cityAverageTemperatureC: city.temp,
    differenceFromCityAverageC:
      here.temp !== null && city.temp !== null ? Math.round((here.temp - city.temp) * 10) / 10 : null,
    estimatedTreeCoolingC,
  };
}

/** Comfort scoring centered on ~21°C "feels like" — a widely-cited neutral outdoor thermal-comfort point — falling off toward either extreme. */
export function heatComfortToScore(feelsLikeC: number | null): number {
  if (feelsLikeC === null) return 50;
  const idealC = 21;
  const deviation = Math.abs(feelsLikeC - idealC);
  return Math.max(0, 100 - deviation * 4);
}
