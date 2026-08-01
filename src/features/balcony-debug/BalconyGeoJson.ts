import { BalconyViewpointCollection, BalconyViewpointFeature, BalconySide } from "./BalconyTypes";
import { BalconyGviResult } from "./BalconyAnalysis";

/** Floor, then side, then balcony number — so a single exported file always reads top-to-bottom by floor. */
function sortForExport(features: BalconyViewpointFeature[]): BalconyViewpointFeature[] {
  return [...features].sort((a, b) => {
    if (a.properties.floor !== b.properties.floor) return a.properties.floor - b.properties.floor;
    if (a.properties.side !== b.properties.side) return a.properties.side.localeCompare(b.properties.side);
    return a.properties.balcony - b.properties.balcony;
  });
}

/** Shared by the download-based export and the auto-save-to-file path, so both write identical, floor-sorted output. */
export function buildExportCollection(
  collection: BalconyViewpointCollection,
  analysisResults?: Map<string, BalconyGviResult>
): BalconyViewpointCollection {
  return {
    type: "FeatureCollection",
    features: sortForExport(collection.features).map((feature) => {
      const analysis = analysisResults?.get(feature.properties.id);
      if (!analysis) return feature;
      return {
        ...feature,
        properties: {
          ...feature.properties,
          gvi_score: Number(analysis.gviScore.toFixed(4)),
        },
      };
    }),
  };
}

export function exportBalconyGeoJson(
  collection: BalconyViewpointCollection,
  analysisResults?: Map<string, BalconyGviResult>
): void {
  const exportCollection = buildExportCollection(collection, analysisResults);

  const blob = new Blob([JSON.stringify(exportCollection, null, 2)], {
    type: "application/geo+json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "balcony_viewpoints.geojson";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function isValidSide(value: unknown): value is BalconySide {
  return value === "North" || value === "South" || value === "East" || value === "West";
}

function isValidFeature(value: unknown): value is BalconyViewpointFeature {
  if (typeof value !== "object" || value === null) return false;
  const feature = value as Record<string, unknown>;
  if (feature.type !== "Feature") return false;

  const properties = feature.properties as Record<string, unknown> | undefined;
  if (
    !properties ||
    typeof properties.id !== "string" ||
    typeof properties.floor !== "number" ||
    !isValidSide(properties.side) ||
    typeof properties.balcony !== "number" ||
    properties.type !== "balcony_viewpoint"
  ) {
    return false;
  }

  const geometry = feature.geometry as Record<string, unknown> | undefined;
  if (
    !geometry ||
    geometry.type !== "Point" ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length !== 3 ||
    !geometry.coordinates.every((c) => typeof c === "number")
  ) {
    return false;
  }

  return true;
}

export async function importBalconyGeoJson(file: File): Promise<BalconyViewpointCollection> {
  const text = await file.text();
  const parsed: unknown = JSON.parse(text);

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { type?: string }).type !== "FeatureCollection" ||
    !Array.isArray((parsed as { features?: unknown }).features)
  ) {
    throw new Error("Invalid GeoJSON: expected a FeatureCollection");
  }

  const features = (parsed as { features: unknown[] }).features.filter(isValidFeature);
  return { type: "FeatureCollection", features };
}
