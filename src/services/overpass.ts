import { OVERPASS_API_URLS } from "../utils/constants";

// overpass.ts is responsible ONLY for talking to the Overpass API.
// It knows nothing about Cesium entities or rendering (see vegetation.ts).

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
  members?: {
    type: "node" | "way" | "relation";
    ref: number;
    role?: string;
    geometry?: { lat: number; lon: number }[];
  }[];
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements: OverpassElement[];
}

/**
 * Builds an Overpass QL query for mapped trees and vegetated land cover.
 * OSM trees complement the current NYC Forestry inventory and are spatially
 * de-duplicated by CombinedVegetationProvider.
 */
function buildVegetationQuery(
  latitude: number,
  longitude: number,
  radiusM: number
): string {
  const around = `around:${radiusM},${latitude},${longitude}`;
  return `
    [out:json][timeout:25];
    (
      node["natural"="tree"](${around});
      node["natural"="shrub"](${around});
      way["natural"="tree_row"](${around});
      way["natural"="wood"](${around});
      relation["natural"="wood"](${around});
      way["landuse"="forest"](${around});
      relation["landuse"="forest"](${around});
      way["landcover"="trees"](${around});
      relation["landcover"="trees"](${around});
      way["landuse"="grass"](${around});
      relation["landuse"="grass"](${around});
      way["landuse"="meadow"](${around});
      relation["landuse"="meadow"](${around});
      way["landuse"="orchard"](${around});
      relation["landuse"="orchard"](${around});
      way["leisure"="garden"](${around});
      relation["leisure"="garden"](${around});
      way["leisure"="park"](${around});
      relation["leisure"="park"](${around});
      way["natural"="scrub"](${around});
      relation["natural"="scrub"](${around});
      way["natural"="shrubbery"](${around});
      relation["natural"="shrubbery"](${around});
      way["landcover"="shrub"](${around});
      relation["landcover"="shrub"](${around});
      way["natural"="heath"](${around});
      relation["natural"="heath"](${around});
      way["natural"="grassland"](${around});
      relation["natural"="grassland"](${around});
    );
    out center geom;
  `.trim();
}

export class OverpassRequestError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A hung/slow mirror would otherwise be waited on indefinitely — fetch()
// has no built-in timeout. This bounds each attempt so a bad mirror gets
// abandoned quickly and the next endpoint/retry gets a chance instead of
// piling up toward a 504.
const OVERPASS_FETCH_TIMEOUT_MS = 12000;

// Successful results are cached in localStorage (keyed by rounded lat/lon +
// radius) so re-analyzing the same spot — repeated "Analyse GVI" clicks, the
// gallery's background polling, or a page reload — returns instantly
// instead of re-hitting the network (and re-risking a 429) every time.
const CACHE_KEY_PREFIX = "overpass-vegetation-cache:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  timestamp: number;
  elements: OverpassElement[];
}

function cacheKey(latitude: number, longitude: number, radiusM: number): string {
  return `${CACHE_KEY_PREFIX}${latitude.toFixed(4)},${longitude.toFixed(4)},${radiusM}`;
}

function readCache(key: string): OverpassElement[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.elements;
  } catch {
    return null;
  }
}

function writeCache(key: string, elements: OverpassElement[]): void {
  try {
    const entry: CacheEntry = { timestamp: Date.now(), elements };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // Storage full/unavailable — caching is a pure optimization, safe to skip.
  }
}

async function fetchWithTimeout(url: string, body: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches raw vegetation elements from Overpass. The public instance
 * regularly fails transiently (timeouts, rate limiting), so this tries
 * each configured endpoint (see OVERPASS_API_URLS), retrying each with a
 * backoff, before finally throwing OverpassRequestError. A 429 (rate
 * limited) waits noticeably longer than a generic failure before retrying —
 * hammering the same endpoint immediately after a 429 just earns another
 * one. Each attempt is bounded by OVERPASS_FETCH_TIMEOUT_MS, and successful
 * results are cached for CACHE_TTL_MS so repeat calls for the same location
 * skip the network entirely.
 */
export async function fetchVegetationRaw(
  latitude: number,
  longitude: number,
  radiusM: number,
  retriesPerEndpoint = 1
): Promise<OverpassElement[]> {
  const key = cacheKey(latitude, longitude, radiusM);
  const cached = readCache(key);
  if (cached) return cached;

  const query = buildVegetationQuery(latitude, longitude, radiusM);
  const attempts: string[] = [];

  for (const url of OVERPASS_API_URLS) {
    for (let attempt = 0; attempt <= retriesPerEndpoint; attempt++) {
      try {
        const response = await fetchWithTimeout(url, query, OVERPASS_FETCH_TIMEOUT_MS);

        if (!response.ok) {
          attempts.push(`${url}: HTTP ${response.status}`);
          if (response.status === 429 && attempt < retriesPerEndpoint) {
            await sleep(5000 * (attempt + 1));
          } else if (attempt < retriesPerEndpoint) {
            await sleep(800 * (attempt + 1));
          }
          continue;
        }

        const data: OverpassResponse = await response.json();
        const elements = data.elements ?? [];
        writeCache(key, elements);
        return elements;
      } catch (err) {
        const isTimeout = (err as Error).name === "AbortError";
        attempts.push(`${url}: ${isTimeout ? `timed out after ${OVERPASS_FETCH_TIMEOUT_MS}ms` : (err as Error).message}`);
        if (attempt < retriesPerEndpoint) {
          await sleep(800 * (attempt + 1));
        }
      }
    }
  }

  throw new OverpassRequestError(
    `Failed to reach Overpass on all endpoints — ${attempts.join("; ")}`
  );
}
