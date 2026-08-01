import {
  ManualVegetationCollection,
  ManualVegetationFeature,
  ManualVegetationPolygon,
} from "../types/ManualVegetationTypes";
import { computePolygonAreaM2, computePolygonCentroid } from "../services/PolygonGeometry";
import defaultManualVegetation from "../defaultManualVegetation.json";

const STORAGE_KEY = "manual-vegetation-polygons";

// Hand-drawn courtyard/gap vegetation shared as the default dataset — used
// whenever localStorage has nothing saved yet, so these already-mapped
// areas show up (and count toward GVI) without needing to redraw them.
const DEFAULT_COLLECTION = defaultManualVegetation as ManualVegetationCollection;

export function loadManualVegetationCollection(): ManualVegetationCollection {
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
    const collection = parsed as ManualVegetationCollection;
    // An empty-but-present entry (e.g. saved before the default dataset
    // existed, or after deleting every polygon) would otherwise permanently
    // block the bundled default from ever showing again — treat it the
    // same as "nothing saved".
    if (collection.features.length === 0) return DEFAULT_COLLECTION;
    return collection;
  } catch {
    return DEFAULT_COLLECTION;
  }
}

export function saveManualVegetationCollection(collection: ManualVegetationCollection): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
}

export function polygonToFeature(polygon: ManualVegetationPolygon): ManualVegetationFeature {
  const ring = [...polygon.positions, polygon.positions[0]].map((p) => [p.longitude, p.latitude]);
  return {
    type: "Feature",
    id: polygon.id,
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: {
      type: "manual_vegetation",
      name: polygon.name,
      source: "manual",
      confidence: 1.0,
      createdAt: polygon.createdAt,
      updatedAt: polygon.updatedAt,
      areaM2: polygon.areaM2,
    },
  };
}

export function featureToPolygon(feature: ManualVegetationFeature): ManualVegetationPolygon {
  const ring = feature.geometry.coordinates[0] ?? [];
  // Ring is closed (first point repeated last) in GeoJSON — drop the duplicate for editing.
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const openRing = closed ? ring.slice(0, -1) : ring;
  const positions = openRing.map(([longitude, latitude]) => ({ longitude, latitude }));
  return {
    id: feature.id,
    name: feature.properties.name,
    positions,
    createdAt: feature.properties.createdAt,
    updatedAt: feature.properties.updatedAt,
    areaM2: feature.properties.areaM2,
    centroid: computePolygonCentroid(positions),
  };
}

export function makePolygonFromPositions(
  positions: { longitude: number; latitude: number }[],
  name: string
): ManualVegetationPolygon {
  const now = Date.now();
  return {
    id: `veg-${now}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    positions,
    createdAt: now,
    updatedAt: now,
    areaM2: computePolygonAreaM2(positions),
    centroid: computePolygonCentroid(positions),
  };
}

export function upsertManualVegetationPolygon(
  collection: ManualVegetationCollection,
  polygon: ManualVegetationPolygon
): ManualVegetationCollection {
  const features = collection.features.filter((f) => f.id !== polygon.id);
  features.push(polygonToFeature(polygon));
  return { type: "FeatureCollection", features };
}

export function removeManualVegetationPolygon(
  collection: ManualVegetationCollection,
  id: string
): ManualVegetationCollection {
  return { type: "FeatureCollection", features: collection.features.filter((f) => f.id !== id) };
}

export function listManualVegetationPolygons(
  collection: ManualVegetationCollection
): ManualVegetationPolygon[] {
  return collection.features.map(featureToPolygon);
}
