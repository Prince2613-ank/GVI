import { BalconyViewpointCollection, BalconyViewpointFeature } from "./BalconyTypes";
import { BalconyGviResult } from "./BalconyAnalysis";
import defaultBalconyViewpoints from "./defaultBalconyViewpoints.json";

const STORAGE_KEY = "balcony-debug-viewpoints";
const ANALYSIS_STORAGE_KEY = "balcony-debug-analysis";

// The exact, hand-captured/verified dataset shared as the default — used
// whenever localStorage has nothing saved yet (first run, cleared storage,
// new browser/device), so every floor/side/flat works out of the box
// without needing to re-import the file by hand.
const DEFAULT_COLLECTION = defaultBalconyViewpoints as BalconyViewpointCollection;

export function loadBalconyCollection(): BalconyViewpointCollection {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_COLLECTION;
    const parsed: unknown = JSON.parse(stored);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { type?: string }).type !== "FeatureCollection" ||
      !Array.isArray((parsed as { features?: unknown }).features)
    ) {
      return DEFAULT_COLLECTION;
    }
    return parsed as BalconyViewpointCollection;
  } catch {
    return DEFAULT_COLLECTION;
  }
}

export function saveBalconyCollection(collection: BalconyViewpointCollection): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
  } catch (error) {
    // Preview image data URLs can push a large collection over the
    // localStorage quota — the in-memory collection (and thus the current
    // session's gallery) is unaffected either way, so this is a warning,
    // not a thrown error.
    // eslint-disable-next-line no-console
    console.warn("[BalconyStorage] Failed to persist balcony collection (quota?):", error);
  }
}

export function upsertBalconyFeature(
  collection: BalconyViewpointCollection,
  feature: BalconyViewpointFeature
): BalconyViewpointCollection {
  const features = collection.features.filter((f) => f.properties.id !== feature.properties.id);
  features.push(feature);
  return { type: "FeatureCollection", features };
}

export function removeBalconyFeature(
  collection: BalconyViewpointCollection,
  id: string
): BalconyViewpointCollection {
  return {
    type: "FeatureCollection",
    features: collection.features.filter((f) => f.properties.id !== id),
  };
}

export function loadBalconyAnalysis(): Map<string, BalconyGviResult> {
  try {
    const stored = window.localStorage.getItem(ANALYSIS_STORAGE_KEY);
    if (!stored) return new Map();
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return new Map();
    return new Map(Object.entries(parsed as Record<string, BalconyGviResult>));
  } catch {
    return new Map();
  }
}

export function saveBalconyAnalysis(results: Map<string, BalconyGviResult>): void {
  window.localStorage.setItem(
    ANALYSIS_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(results))
  );
}
