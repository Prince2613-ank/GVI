// Thin client for the backend's Vegetation Health endpoint
// (backend/src/routes/vegetationHealth.ts).

import { DEMO_BUILDING_ID } from "../wellness/wellnessApi";

const API_BASE =
  (import.meta.env.VITE_BALCONY_API_URL as string | undefined)?.replace(
    /\/api\/balcony-viewpoints\/?$/,
    "/api/vegetation-health"
  ) ?? "http://localhost:4100/api/vegetation-health";

export interface SpeciesBreakdownEntry {
  species: string;
  count: number;
}

export interface VegetationHealthResult {
  totalTrees: number;
  ratedTrees: number;
  goodCount: number;
  fairCount: number;
  poorCount: number;
  conditionScore: number;
  distinctSpeciesCount: number;
  diversityScore: number;
  topSpecies: SpeciesBreakdownEntry[];
  overallScore: number;
  radiusM: number;
  dataSource: string;
}

export async function fetchVegetationHealth(
  buildingId: string = DEMO_BUILDING_ID
): Promise<VegetationHealthResult> {
  const response = await fetch(`${API_BASE}/${buildingId}`);
  if (!response.ok) throw new Error(`Vegetation Health API failed (${response.status})`);
  return response.json() as Promise<VegetationHealthResult>;
}
