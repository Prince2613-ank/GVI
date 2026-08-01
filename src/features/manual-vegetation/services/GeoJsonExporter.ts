import { ManualVegetationCollection } from "../types/ManualVegetationTypes";

export function exportManualVegetationGeoJson(collection: ManualVegetationCollection): void {
  const blob = new Blob([JSON.stringify(collection, null, 2)], {
    type: "application/geo+json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "manual_vegetation.geojson";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
