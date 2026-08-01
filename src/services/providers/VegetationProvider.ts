import { VegetationFeature } from "../vegetation";

export interface VegetationQuery {
  latitude: number;
  longitude: number;
  radiusM: number;
}

/**
 * Common contract for any vegetation data source. Consumers (hooks,
 * components) depend only on this interface, so individual sources —
 * Overpass, NYC Forestry Tree Points, or future providers (e.g. a
 * satellite-derived NDVI layer) — can be added, swapped, or combined
 * without touching calling code.
 */
export interface VegetationProvider {
  /** Short identifier used in error messages and source-breakdown stats. */
  readonly name: string;
  fetchVegetation(query: VegetationQuery): Promise<VegetationFeature[]>;
}
