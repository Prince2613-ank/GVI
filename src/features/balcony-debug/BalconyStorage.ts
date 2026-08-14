import { BalconyViewpointCollection, BalconyViewpointFeature } from "./BalconyTypes";
import { BalconyGviResult } from "./BalconyAnalysis";
import defaultBalconyViewpoints from "./defaultBalconyViewpoints.json";

const DB_NAME = "gvi-balcony-debug";
const DB_VERSION = 1;
const STORE_NAME = "kv";

const COLLECTION_KEY = "balcony-debug-viewpoints";
const ANALYSIS_KEY = "balcony-debug-analysis";

// The exact, hand-captured/verified dataset shared as the default — used
// whenever storage has nothing saved yet (first run, cleared storage, new
// browser/device), so every floor/side/flat works out of the box without
// needing to re-import the file by hand.
export const DEFAULT_COLLECTION = defaultBalconyViewpoints as BalconyViewpointCollection;

// Viewpoint previews carry full captured-view screenshot data URLs and are
// meant to stay saved until the next resync overwrites them — with ~100
// viewpoints per sync that easily exceeds localStorage's ~5-10MB per-origin
// quota (QuotaExceededError). IndexedDB's quota is a large fraction of free
// disk space, so it holds the same always-persisted images without falling
// over.
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadBalconyCollection(): Promise<BalconyViewpointCollection> {
  try {
    const stored = await idbGet<unknown>(COLLECTION_KEY);
    if (
      typeof stored !== "object" ||
      stored === null ||
      (stored as { type?: string }).type !== "FeatureCollection" ||
      !Array.isArray((stored as { features?: unknown }).features)
    ) {
      return DEFAULT_COLLECTION;
    }
    return stored as BalconyViewpointCollection;
  } catch {
    return DEFAULT_COLLECTION;
  }
}

export async function saveBalconyCollection(collection: BalconyViewpointCollection): Promise<void> {
  try {
    await idbSet(COLLECTION_KEY, collection);
  } catch (error) {
    // The in-memory collection (and thus the current session's gallery) is
    // unaffected either way, so this is a warning, not a thrown error.
    // eslint-disable-next-line no-console
    console.warn("[BalconyStorage] Failed to persist balcony collection:", error);
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

export async function loadBalconyAnalysis(): Promise<Map<string, BalconyGviResult>> {
  try {
    const stored = await idbGet<Record<string, BalconyGviResult>>(ANALYSIS_KEY);
    if (typeof stored !== "object" || stored === null) return new Map();
    return new Map(Object.entries(stored));
  } catch {
    return new Map();
  }
}

export async function saveBalconyAnalysis(results: Map<string, BalconyGviResult>): Promise<void> {
  await idbSet(ANALYSIS_KEY, Object.fromEntries(results));
}
