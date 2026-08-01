import { VegetationSummary } from "./vegetation";

// Persists the last-fetched vegetation summary to localStorage, keyed by a
// rounded lat/lon, so a page reload (or a return visit) can show data
// immediately instead of waiting on the vegetation providers again —
// notably Overpass, which has been observed returning slow/504 responses
// in this app. useVegetation's in-memory cache (lastFetchLocationRef)
// already avoids redundant fetches WITHIN a session; this covers the same
// thing ACROSS page reloads, which the in-memory cache can't since it's
// wiped on every reload.

const STORAGE_PREFIX = "gvi-vegetation-cache:";
// Real-world tree/canopy data doesn't change meaningfully within a browser
// session — but a TTL still bounds how long a page can keep serving data
// that's gone stale relative to whatever the providers would return now
// (e.g. after a backend dataset update).
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
// ~11m precision at these latitudes — matches VEGETATION_CACHE_MOVE_THRESHOLD_M's
// intent (small building moves reuse the same fetch) without needing exact
// float equality on the cache key.
const COORDINATE_PRECISION = 4;

interface CachedEntry {
  summary: VegetationSummary;
  cachedAtMs: number;
}

function cacheKey(latitude: number, longitude: number): string {
  return `${STORAGE_PREFIX}${latitude.toFixed(COORDINATE_PRECISION)},${longitude.toFixed(COORDINATE_PRECISION)}`;
}

export function getCachedVegetation(latitude: number, longitude: number): VegetationSummary | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(latitude, longitude));
    if (!raw) return null;
    const entry = JSON.parse(raw) as CachedEntry;
    if (Date.now() - entry.cachedAtMs > CACHE_TTL_MS) {
      window.localStorage.removeItem(cacheKey(latitude, longitude));
      return null;
    }
    return entry.summary;
  } catch (error) {
    // Corrupt entry, localStorage disabled (private browsing in some
    // browsers), or quota exceeded — treat exactly like a cache miss.
    console.warn("[vegetationCache] Failed to read cache; ignoring", error);
    return null;
  }
}

export function setCachedVegetation(
  latitude: number,
  longitude: number,
  summary: VegetationSummary
): void {
  try {
    const entry: CachedEntry = { summary, cachedAtMs: Date.now() };
    window.localStorage.setItem(cacheKey(latitude, longitude), JSON.stringify(entry));
  } catch (error) {
    // Quota exceeded (vegetation summaries can be sizable with many trees)
    // or localStorage unavailable — losing the cache write isn't fatal,
    // the app just falls back to a live fetch next time.
    console.warn("[vegetationCache] Failed to write cache; continuing without it", error);
  }
}
