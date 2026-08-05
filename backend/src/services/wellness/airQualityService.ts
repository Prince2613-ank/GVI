// Primary source: EPA AirNow — real physical monitoring stations, the
// authoritative US air-quality source, with solid coverage in NYC. Needs
// AIRNOW_API_KEY (see backend/.env). Falls back to Open-Meteo's Air
// Quality API (keyless, model-based rather than station-based, works
// everywhere including gaps between AirNow stations) if AirNow has no
// station within range, the request fails, or no key is configured.
const AIRNOW_API_URL = "https://www.airnowapi.org/aq/observation/latLong/current/";
const OPEN_METEO_AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const AIRNOW_SEARCH_RADIUS_MILES = 25;

export type AqiStatus = "Good" | "Moderate" | "Unhealthy for Sensitive Groups" | "Unhealthy" | "Very Unhealthy" | "Hazardous";

export interface AirQualityResult {
  aqi: number | null;
  pm2_5: number | null;
  status: AqiStatus | null;
  source: "airnow" | "open-meteo" | "unavailable";
}

function aqiToStatus(aqi: number): AqiStatus {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

/** US EPA AQI scale is already 0-100+ "lower is better" — inverted here so higher = healthier, matching every other 0-100 wellness metric. */
export function aqiToScore(aqi: number): number {
  return Math.max(0, 100 - aqi);
}

interface AirNowObservation {
  ParameterName: string;
  AQI: number;
  Category: { Number: number; Name: string };
}

/** AirNow reports one row per pollutant (PM2.5, Ozone, etc.) — the overall AQI is the worst (highest) of them, same convention the EPA itself uses. */
async function fetchFromAirNow(latitude: number, longitude: number): Promise<AirQualityResult | null> {
  const apiKey = process.env.AIRNOW_API_KEY;
  if (!apiKey) return null;

  const url = `${AIRNOW_API_URL}?format=application/json&latitude=${latitude}&longitude=${longitude}&distance=${AIRNOW_SEARCH_RADIUS_MILES}&API_KEY=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`AirNow API returned ${response.status}`);
  const observations = (await response.json()) as AirNowObservation[];
  if (!Array.isArray(observations) || observations.length === 0) return null; // no station within range

  const worst = observations.reduce((max, obs) => (obs.AQI > max.AQI ? obs : max));
  return {
    aqi: worst.AQI,
    pm2_5: null, // AirNow's current-observation endpoint reports per-pollutant AQI, not raw µg/m³ concentration
    status: aqiToStatus(worst.AQI),
    source: "airnow",
  };
}

async function fetchFromOpenMeteo(latitude: number, longitude: number): Promise<AirQualityResult> {
  const url = `${OPEN_METEO_AIR_QUALITY_URL}?latitude=${latitude}&longitude=${longitude}&current=us_aqi,pm2_5`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo air-quality API returned ${response.status}`);
  const data = (await response.json()) as { current?: { us_aqi?: number; pm2_5?: number } };
  const aqi = data.current?.us_aqi ?? null;
  return {
    aqi,
    pm2_5: data.current?.pm2_5 ?? null,
    status: aqi === null ? null : aqiToStatus(aqi),
    source: aqi === null ? "unavailable" : "open-meteo",
  };
}

export async function fetchAirQuality(latitude: number, longitude: number): Promise<AirQualityResult> {
  try {
    const fromAirNow = await fetchFromAirNow(latitude, longitude);
    if (fromAirNow) return fromAirNow;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[Wellness] AirNow lookup failed, falling back to Open-Meteo", error);
  }
  return fetchFromOpenMeteo(latitude, longitude);
}
