import { pool } from "../../db/client";
import { computeTreeCanopy, TreeCanopyResult } from "./treeCanopyService";
import { computeNoiseEstimate, NoiseEstimateResult, NoiseLevel } from "./noiseService";
import { fetchAirQuality, aqiToScore, AqiStatus } from "./airQualityService";
import { computeHeatComfort, heatComfortToScore } from "./heatService";

// Green View and Park Accessibility removed from the active score (see
// migration 1700000000004) — remaining four weights rescaled from the
// original 6-metric spec (Canopy 20 / AQI 20 / Heat 15 / Noise 10) to sum
// to 100 on their own: 20/65, 20/65, 15/65, 10/65 × 100 ≈ 31/31/23/15.
const WEIGHTS = {
  treeCanopy: 31,
  airQuality: 31,
  heat: 23,
  noise: 15,
};

// Split cache tiers, not one blanket age — matches how fast each source
// actually changes. Tree Canopy/Noise come from Overpass/NYC Forestry
// (rate-limited, and physically don't change minute to minute — a tree
// doesn't move), so they're cached for a day. Air Quality and Heat Comfort
// are genuinely live conditions — caching those for any real length of
// time is exactly what made the panel feel stale/static, so they're
// recomputed on every single request instead, never stored in the cache
// row at all.
const SLOW_TIER_MAX_AGE_MS = 24 * 60 * 60 * 1000; // Tree Canopy + Noise

function noiseToScore(level: NoiseLevel): number {
  return { Quiet: 92, Moderate: 60, Busy: 30 }[level];
}

interface SlowTier {
  canopy: TreeCanopyResult;
  noise: NoiseEstimateResult;
  computedAt: string;
  cacheHit: boolean;
}

async function computeFreshSlowTier(latitude: number, longitude: number): Promise<{ canopy: TreeCanopyResult; noise: NoiseEstimateResult }> {
  const [canopy, noise] = await Promise.all([
    computeTreeCanopy(latitude, longitude),
    computeNoiseEstimate(latitude, longitude),
  ]);
  return { canopy, noise };
}

/** Cached separately from the live tier — a day-old tree count/noise estimate is still accurate; a day-old AQI reading is not. */
async function getSlowTier(buildingId: string, latitude: number, longitude: number, forceRefresh: boolean): Promise<SlowTier> {
  if (!forceRefresh) {
    const { rows } = await pool.query(
      `SELECT * FROM gv_wellness_snapshots WHERE building_id = $1 ORDER BY computed_at DESC LIMIT 1`,
      [buildingId]
    );
    const existing = rows[0];
    if (existing && Date.now() - new Date(existing.computed_at).getTime() < SLOW_TIER_MAX_AGE_MS) {
      const raw = existing.raw_metrics;
      return {
        canopy: {
          treeCount: raw.treeCount,
          nycForestryCount: raw.nycForestryCount,
          overpassOnlyCount: raw.overpassOnlyCount,
          estimatedCanopyCoveragePct: raw.estimatedCanopyCoveragePct,
          radiusM: raw.treeCanopyRadiusM,
        },
        noise: {
          level: raw.noiseLevel,
          nearestMajorRoadM: raw.nearestMajorRoadM,
          method: raw.noiseMethod,
        },
        computedAt: existing.computed_at,
        cacheHit: true,
      };
    }
  }

  const fresh = await computeFreshSlowTier(latitude, longitude);
  const { rows } = await pool.query(
    `INSERT INTO gv_wellness_snapshots
       (building_id, overall_score, tree_canopy_score, air_quality_score, heat_comfort_score, noise_score, raw_metrics, insights, recommendations)
     VALUES ($1,0,$2,50,50,$3,$4,'[]','[]')
     RETURNING computed_at`,
    [
      buildingId,
      Math.round(fresh.canopy.estimatedCanopyCoveragePct * 10) / 10,
      noiseToScore(fresh.noise.level),
      JSON.stringify({
        treeCount: fresh.canopy.treeCount,
        nycForestryCount: fresh.canopy.nycForestryCount,
        overpassOnlyCount: fresh.canopy.overpassOnlyCount,
        estimatedCanopyCoveragePct: fresh.canopy.estimatedCanopyCoveragePct,
        treeCanopyRadiusM: fresh.canopy.radiusM,
        noiseLevel: fresh.noise.level,
        nearestMajorRoadM: fresh.noise.nearestMajorRoadM,
        noiseMethod: fresh.noise.method,
      }),
    ]
  );
  return { ...fresh, computedAt: rows[0].computed_at, cacheHit: false };
}

function buildInsights(raw: {
  treeCount: number;
  nycForestryCount: number;
  overpassOnlyCount: number;
  canopyPct: number;
  noiseLevel: NoiseLevel;
  aqi: number | null;
  aqiStatus: AqiStatus | null;
  feelsLikeC: number | null;
  diffFromCityC: number | null;
  treeCoolingC: number;
}): string[] {
  const insights: string[] = [];
  if (raw.canopyPct >= 30) {
    insights.push(
      `Dense tree canopy nearby (${raw.treeCount} trees — ${raw.nycForestryCount} from NYC's official inventory, ${raw.overpassOnlyCount} additional from OpenStreetMap) helps cool the surrounding area.`
    );
  } else if (raw.treeCount > 0) {
    insights.push(`Some tree cover nearby (${raw.treeCount} trees), but canopy density is limited.`);
  } else {
    insights.push(`Little to no mapped tree canopy in the immediate surroundings.`);
  }
  if (raw.aqi !== null && raw.aqiStatus) {
    insights.push(`Current air quality: ${raw.aqiStatus} (AQI ${raw.aqi}).`);
  }
  if (raw.diffFromCityC !== null) {
    if (raw.diffFromCityC <= -1) {
      insights.push(`Feels ${Math.abs(raw.diffFromCityC).toFixed(1)}°C cooler here than the city average right now.`);
    } else if (raw.diffFromCityC >= 1) {
      insights.push(`Feels ${raw.diffFromCityC.toFixed(1)}°C warmer here than the city average right now.`);
    }
  }
  if (raw.treeCoolingC > 0.3) {
    insights.push(`Nearby tree canopy is estimated to reduce local temperature by roughly ${raw.treeCoolingC}°C.`);
  }
  if (raw.noiseLevel === "Quiet") {
    insights.push(`Estimated to be a quiet location — no major road within close range.`);
  } else if (raw.noiseLevel === "Busy") {
    insights.push(`Close to a major road — expect more traffic noise, especially during rush hour.`);
  }
  return insights;
}

function buildRecommendations(scores: {
  treeCanopyScore: number;
  airQualityScore: number;
  heatComfortScore: number;
  noiseScore: number;
}): string[] {
  const recommendations: string[] = [];
  if (scores.noiseScore >= 70) {
    recommendations.push("Ideal for remote work — estimated to be a quiet environment");
  } else if (scores.noiseScore < 40) {
    recommendations.push("Noise increases near rush hour — consider double-glazed windows");
  }
  if (scores.treeCanopyScore >= 60) {
    recommendations.push("Excellent tree cover for shade and outdoor comfort");
  } else if (scores.treeCanopyScore < 30) {
    recommendations.push("Limited shade nearby — afternoon sun exposure may be significant");
  }
  if (scores.airQualityScore < 50) {
    recommendations.push("Air quality is currently a concern — check before planning extended outdoor time");
  } else if (scores.airQualityScore >= 80) {
    recommendations.push("Air quality is currently good for outdoor activity");
  }
  if (scores.heatComfortScore < 40) {
    recommendations.push("Current conditions are outside typical outdoor comfort range");
  }
  return recommendations;
}

export interface WellnessSnapshot {
  overallScore: number;
  treeCanopyScore: number;
  airQualityScore: number;
  heatComfortScore: number;
  noiseScore: number;
  rawMetrics: Record<string, unknown>;
  insights: string[];
  recommendations: string[];
  computedAt: string;
  /** True only if the slow tier (Tree Canopy/Noise) came from cache — Air Quality/Heat are always freshly computed, every request. */
  cacheHit: boolean;
}

/**
 * Air Quality and Heat Comfort are ALWAYS recomputed live here — no
 * caching — since those are the two metrics a person actually expects to
 * change minute to minute. Tree Canopy and Noise come from a cached slow
 * tier (see getSlowTier) since their sources are rate-limited and the
 * underlying reality barely changes day to day.
 */
export async function getWellnessSnapshot(
  buildingId: string,
  latitude: number,
  longitude: number,
  forceRefresh = false
): Promise<WellnessSnapshot> {
  const slow = await getSlowTier(buildingId, latitude, longitude, forceRefresh);

  const [airQuality, heat] = await Promise.all([
    fetchAirQuality(latitude, longitude).catch(
      () => ({ aqi: null, pm2_5: null, status: null, source: "unavailable" as const })
    ),
    computeHeatComfort(latitude, longitude, slow.canopy.estimatedCanopyCoveragePct).catch(() => ({
      temperatureC: null,
      feelsLikeC: null,
      cityAverageTemperatureC: null,
      differenceFromCityAverageC: null,
      estimatedTreeCoolingC: 0,
    })),
  ]);

  const treeCanopyScore = slow.canopy.estimatedCanopyCoveragePct;
  const noiseScore = noiseToScore(slow.noise.level);
  const airQualityScore = airQuality.aqi === null ? 50 : aqiToScore(airQuality.aqi);
  const heatComfortScore = heatComfortToScore(heat.feelsLikeC);

  const overallScore =
    (treeCanopyScore * WEIGHTS.treeCanopy +
      airQualityScore * WEIGHTS.airQuality +
      heatComfortScore * WEIGHTS.heat +
      noiseScore * WEIGHTS.noise) /
    100;

  const rawMetrics = {
    treeCount: slow.canopy.treeCount,
    nycForestryCount: slow.canopy.nycForestryCount,
    overpassOnlyCount: slow.canopy.overpassOnlyCount,
    treeCanopyRadiusM: slow.canopy.radiusM,
    estimatedCanopyCoveragePct: slow.canopy.estimatedCanopyCoveragePct,
    canopySources: "NYC Forestry Tree Points (official inventory) + OpenStreetMap (deduplicated)",
    canopyComputedAt: slow.computedAt,
    noiseLevel: slow.noise.level,
    nearestMajorRoadM: slow.noise.nearestMajorRoadM,
    noiseMethod: slow.noise.method,
    aqi: airQuality.aqi,
    aqiStatus: airQuality.status,
    pm2_5: airQuality.pm2_5,
    airQualitySource: airQuality.source,
    temperatureC: heat.temperatureC,
    feelsLikeC: heat.feelsLikeC,
    cityAverageTemperatureC: heat.cityAverageTemperatureC,
    differenceFromCityAverageC: heat.differenceFromCityAverageC,
    estimatedTreeCoolingC: heat.estimatedTreeCoolingC,
    weights: WEIGHTS,
  };

  return {
    overallScore: Math.round(overallScore * 10) / 10,
    treeCanopyScore: Math.round(treeCanopyScore * 10) / 10,
    airQualityScore: Math.round(airQualityScore * 10) / 10,
    heatComfortScore: Math.round(heatComfortScore * 10) / 10,
    noiseScore,
    rawMetrics,
    insights: buildInsights({
      treeCount: slow.canopy.treeCount,
      nycForestryCount: slow.canopy.nycForestryCount,
      overpassOnlyCount: slow.canopy.overpassOnlyCount,
      canopyPct: slow.canopy.estimatedCanopyCoveragePct,
      noiseLevel: slow.noise.level,
      aqi: airQuality.aqi,
      aqiStatus: airQuality.status,
      feelsLikeC: heat.feelsLikeC,
      diffFromCityC: heat.differenceFromCityAverageC,
      treeCoolingC: heat.estimatedTreeCoolingC,
    }),
    recommendations: buildRecommendations({ treeCanopyScore, airQualityScore, heatComfortScore, noiseScore }),
    computedAt: new Date().toISOString(),
    cacheHit: slow.cacheHit,
  };
}
