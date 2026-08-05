// Shared Overpass query helper for the wellness metric services below —
// same multi-mirror-with-retry pattern the frontend's OverpassProvider.ts
// already uses (the primary instance times out/rate-limits often in
// practice), reimplemented here since these metrics need to run server-side
// (cached in gv_wellness_snapshots) rather than recomputed in the browser.
const OVERPASS_API_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export async function runOverpassQuery(query: string): Promise<OverpassElement[]> {
  let lastError: unknown;
  for (const url of OVERPASS_API_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: query,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`Overpass ${url} returned ${response.status}`);
      const data = (await response.json()) as { elements: OverpassElement[] };
      return data.elements;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All Overpass mirrors failed");
}

/** Haversine distance in meters — good enough at city scale, no need for a full geodesic library. */
export function haversineDistanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function elementLatLon(el: OverpassElement): { lat: number; lon: number } | null {
  if (el.lat !== undefined && el.lon !== undefined) return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}
