import { ManualVegetationCollection, ManualVegetationFeature } from "../types/ManualVegetationTypes";

function isValidFeature(value: unknown): value is ManualVegetationFeature {
  if (typeof value !== "object" || value === null) return false;
  const feature = value as Record<string, unknown>;
  if (feature.type !== "Feature" || typeof feature.id !== "string") return false;

  const geometry = feature.geometry as Record<string, unknown> | undefined;
  if (
    !geometry ||
    geometry.type !== "Polygon" ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length === 0 ||
    !Array.isArray(geometry.coordinates[0]) ||
    geometry.coordinates[0].length < 4
  ) {
    return false;
  }

  const properties = feature.properties as Record<string, unknown> | undefined;
  if (!properties || properties.type !== "manual_vegetation" || typeof properties.name !== "string") {
    return false;
  }

  return true;
}

export async function importManualVegetationGeoJson(file: File): Promise<ManualVegetationCollection> {
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
