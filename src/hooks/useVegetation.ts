import { useCallback, useEffect, useRef, useState } from "react";
import { CombinedVegetationProvider } from "../services/providers/CombinedVegetationProvider";
import { summarizeVegetation, VegetationSummary } from "../services/vegetation";
import { haversineDistanceM } from "../utils/geo";
import {
  VEGETATION_CACHE_MOVE_THRESHOLD_M,
  VEGETATION_SEARCH_RADIUS_M,
} from "../utils/constants";
import { resolveTreeHeights } from "../services/treeHeight";
import { buildTreeCanopies } from "../services/canopy";
import { getCachedVegetation, setCachedVegetation } from "../services/vegetationCache";

// useVegetation fetches nearby vegetation for the building's current
// location via CombinedVegetationProvider (NYC Forestry + Overpass),
// caching the last result so small building moves (< 100m,
// STEP 13) don't trigger redundant API requests.

export type VegetationLoadState = "idle" | "loading" | "loaded" | "error";

export interface UseVegetationResult {
  summary: VegetationSummary | null;
  state: VegetationLoadState;
  errorMessage: string | null;
  /** Non-fatal per-source failures (e.g. one provider down while others succeeded). */
  partialFailures: string[];
  /** Re-runs the fetch for the current location, bypassing the move-distance cache. */
  refetch: () => Promise<VegetationSummary | null>;
}

interface UseVegetationOptions {
  autoFetch?: boolean;
}

export function useVegetation(
  latitude: number,
  longitude: number,
  { autoFetch = true }: UseVegetationOptions = {}
): UseVegetationResult {
  const [summary, setSummary] = useState<VegetationSummary | null>(null);
  const [state, setState] = useState<VegetationLoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [partialFailures, setPartialFailures] = useState<string[]>([]);

  const providerRef = useRef(new CombinedVegetationProvider());
  const lastFetchLocationRef = useRef<{ lat: number; lon: number } | null>(null);
  const cancelledRef = useRef(false);

  // Set true whenever the CURRENT summary on screen came from the
  // localStorage cache rather than a completed live fetch — read by
  // runFetch's catch block below so a slow/failing provider (Overpass has
  // been observed returning 504s) doesn't blow away perfectly good cached
  // data with an error state; it just leaves the cached data showing and
  // logs a warning instead.
  const showingCachedFallbackRef = useRef(false);

  const runFetch = useCallback(async (lat: number, lon: number): Promise<VegetationSummary | null> => {
    cancelledRef.current = false;
    setErrorMessage(null);
    setPartialFailures([]);

    // Stale-while-revalidate: a cached entry (if any) renders immediately —
    // real vegetation data doesn't change moment to moment, so there's no
    // reason to sit on a loading spinner for however long the live fetch
    // takes when yesterday's data is still perfectly usable. The live fetch
    // below still always runs afterward and overwrites this with fresh data
    // on success.
    const cached = getCachedVegetation(lat, lon);
    if (cached) {
      showingCachedFallbackRef.current = true;
      setSummary(cached);
      setState("loaded");
    } else {
      showingCachedFallbackRef.current = false;
      setState("loading");
    }

    try {
      const features = await providerRef.current.fetchVegetation({
        latitude: lat,
        longitude: lon,
        radiusM: VEGETATION_SEARCH_RADIUS_M,
      });
      if (cancelledRef.current) return null;
      lastFetchLocationRef.current = { lat, lon };
      const normalized = resolveTreeHeights(features);
      const withCanopy = buildTreeCanopies(normalized);
      const nextSummary = summarizeVegetation(withCanopy);
      console.info("[Tree height] Load report", nextSummary.heightReport);
      console.info("[Canopy] Load report", nextSummary.canopyReport);
      setSummary(nextSummary);
      setPartialFailures(providerRef.current.lastPartialFailures);
      setState("loaded");
      showingCachedFallbackRef.current = false;
      setCachedVegetation(lat, lon, nextSummary);
      return nextSummary;
    } catch (err) {
      if (cancelledRef.current) return null;
      if (showingCachedFallbackRef.current) {
        // Already showing cached data for this location — a failed refresh
        // isn't worth surfacing as a hard error over data that's still on
        // screen and was fine 30 minutes ago.
        console.warn(
          "[useVegetation] Live refresh failed; continuing to show cached data",
          err
        );
        return null;
      }
      setErrorMessage(
        err instanceof Error ? err.message : "Unknown error fetching vegetation data"
      );
      setState("error");
      return null;
    }
  }, []);

  useEffect(() => {
    if (!autoFetch) return;

    const last = lastFetchLocationRef.current;
    const movedM = last
      ? haversineDistanceM(last.lat, last.lon, latitude, longitude)
      : Infinity;

    if (last && movedM < VEGETATION_CACHE_MOVE_THRESHOLD_M) {
      // Building moved less than the cache threshold — reuse existing data.
      return;
    }

    void runFetch(latitude, longitude);

    return () => {
      cancelledRef.current = true;
    };
  }, [autoFetch, latitude, longitude, runFetch]);

  const refetch = useCallback(() => {
    return runFetch(latitude, longitude);
  }, [runFetch, latitude, longitude]);

  return { summary, state, errorMessage, partialFailures, refetch };
}
