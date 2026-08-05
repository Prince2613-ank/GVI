// Thin client for the backend's Green Wellness Score endpoint
// (backend/src/routes/wellness.ts) — same shared backend the balcony
// viewpoints/GVI leaderboard already talk to (see balconyGenerationApi.ts).

const API_BASE =
  (import.meta.env.VITE_BALCONY_API_URL as string | undefined)?.replace(
    /\/api\/balcony-viewpoints\/?$/,
    "/api/wellness"
  ) ?? "http://localhost:4100/api/wellness";

// Matches the single seeded demo building's fixed id (backend's
// 1700000000000_init.js migration) — same building the balcony viewpoint
// system already assumes when no explicit buildingId is passed.
export const DEMO_BUILDING_ID = "00000000-0000-0000-0000-000000000001";

export type AqiStatus =
  | "Good"
  | "Moderate"
  | "Unhealthy for Sensitive Groups"
  | "Unhealthy"
  | "Very Unhealthy"
  | "Hazardous";

// Green View and Park Accessibility are intentionally not part of this
// score — GVI is a per-window measurement, not a single building-level
// fact the way the remaining four site-level metrics are, and Park
// Accessibility was dropped in favor of the richer multi-source Tree
// Canopy metric below (backend/src/services/wellness/wellnessAggregatorService.ts).
export interface WellnessSnapshot {
  overallScore: number;
  treeCanopyScore: number;
  airQualityScore: number;
  heatComfortScore: number;
  noiseScore: number;
  rawMetrics: {
    treeCount: number;
    nycForestryCount: number;
    overpassOnlyCount: number;
    treeCanopyRadiusM: number;
    estimatedCanopyCoveragePct: number;
    canopySources: string;
    noiseLevel: "Quiet" | "Moderate" | "Busy";
    nearestMajorRoadM: number | null;
    aqi: number | null;
    aqiStatus: AqiStatus | null;
    pm2_5: number | null;
    airQualitySource: string;
    temperatureC: number | null;
    feelsLikeC: number | null;
    cityAverageTemperatureC: number | null;
    differenceFromCityAverageC: number | null;
    estimatedTreeCoolingC: number;
  };
  computedAt: string;
  cacheHit: boolean;
}

export async function fetchWellnessSnapshot(
  buildingId: string = DEMO_BUILDING_ID,
  forceRefresh = false
): Promise<WellnessSnapshot> {
  const query = forceRefresh ? "?refresh=true" : "";
  const response = await fetch(`${API_BASE}/${buildingId}${query}`);
  if (!response.ok) throw new Error(`Wellness API failed (${response.status})`);
  return response.json() as Promise<WellnessSnapshot>;
}
