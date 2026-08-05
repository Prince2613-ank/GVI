import { runOverpassQuery, elementLatLon, haversineDistanceM } from "./overpassClient";

const SEARCH_RADIUS_M = 300;
const MAJOR_ROAD_TAGS = ["motorway", "trunk", "primary", "secondary"];

export type NoiseLevel = "Quiet" | "Moderate" | "Busy";

export interface NoiseEstimateResult {
  level: NoiseLevel;
  nearestMajorRoadM: number | null;
  /** Explicitly labeled as an estimate, not a measurement — this app has no real acoustic sensor data (NYC 311 noise complaints are a Phase 2 addition, this heuristic exists so the metric isn't just missing in the meantime). */
  method: "estimated_from_road_proximity";
}

/**
 * Distance-to-nearest-major-road heuristic: the closer a location is to a
 * motorway/trunk/primary/secondary road, the more likely it experiences
 * traffic noise. A real measurement (NYC 311 noise complaint density, or an
 * actual acoustic sensor feed) would be more accurate — this is the
 * zero-new-dependency version, reusing the same Overpass road data other
 * NYC-focused tools already query.
 */
export async function computeNoiseEstimate(
  latitude: number,
  longitude: number
): Promise<NoiseEstimateResult> {
  const query = `
    [out:json][timeout:15];
    (
      way["highway"~"^(${MAJOR_ROAD_TAGS.join("|")})$"](around:${SEARCH_RADIUS_M},${latitude},${longitude});
    );
    out center;
  `;
  const elements = await runOverpassQuery(query);

  let nearestM: number | null = null;
  for (const el of elements) {
    const pos = elementLatLon(el);
    if (!pos) continue;
    const distanceM = haversineDistanceM(latitude, longitude, pos.lat, pos.lon);
    if (nearestM === null || distanceM < nearestM) nearestM = distanceM;
  }

  let level: NoiseLevel;
  if (nearestM === null || nearestM > 200) level = "Quiet";
  else if (nearestM > 80) level = "Moderate";
  else level = "Busy";

  return {
    level,
    nearestMajorRoadM: nearestM === null ? null : Math.round(nearestM),
    method: "estimated_from_road_proximity",
  };
}
