import { VegetationFeature } from "../vegetation";
import {
  NYC_FORESTRY_TREE_API_URL,
  VEGETATION_COLORS,
} from "../../utils/constants";
import { haversineDistanceM } from "../../utils/geo";
import { VegetationProvider, VegetationQuery } from "./VegetationProvider";

// The filename/class name is retained to avoid a needless public API break,
// but this provider now uses NYC Parks' current Forestry Tree Points dataset
// (ForMS), not the historical 2015 street-only census. ForMS includes active
// trees in public rights-of-way and landscaped park areas.

export class NYCTreeRequestError extends Error {}

interface ForestryTreeRow {
  objectid: string;
  dbh?: string;
  tpstructure?: string;
  tpcondition?: string;
  genusspecies?: string;
  location?: {
    type: "Point";
    coordinates: [number, number];
  };
}

function buildRequestUrl(query: VegetationQuery): string {
  const where = `within_circle(location, ${query.latitude}, ${query.longitude}, ${query.radiusM})`;
  const params = new URLSearchParams({
    $where: where,
    $select: "objectid,dbh,tpstructure,tpcondition,genusspecies,location",
    $limit: "5000",
  });
  return `${NYC_FORESTRY_TREE_API_URL}?${params.toString()}`;
}

function isLivingTree(row: ForestryTreeRow): boolean {
  const structure = row.tpstructure?.toLowerCase() ?? "";
  const condition = row.tpcondition?.toLowerCase() ?? "";
  return !structure.includes("stump") && !condition.includes("dead");
}

export class NYCStreetTreeProvider implements VegetationProvider {
  readonly name = "nyc_forestry";

  async fetchVegetation(query: VegetationQuery): Promise<VegetationFeature[]> {
    let response: Response;
    try {
      response = await fetch(buildRequestUrl(query));
    } catch (err) {
      throw new NYCTreeRequestError(
        `Failed to reach NYC Forestry Tree Points API: ${(err as Error).message}`
      );
    }

    if (!response.ok) {
      throw new NYCTreeRequestError(
        `NYC Forestry Tree Points API returned status ${response.status}`
      );
    }

    const rows = (await response.json()) as ForestryTreeRow[];
    const features: VegetationFeature[] = [];
    for (const row of rows) {
      if (!row.location || !isLivingTree(row)) continue;
      const [longitude, latitude] = row.location.coordinates;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      if (
        haversineDistanceM(
          query.latitude,
          query.longitude,
          latitude,
          longitude
        ) > query.radiusM
      ) {
        continue;
      }

      const dbhInches = row.dbh ? Number(row.dbh) : undefined;
      features.push({
        kind: "point",
        id: `nyc-forestry-${row.objectid}`,
        source: "nyc_forestry",
        category: "tree",
        color: VEGETATION_COLORS.tree,
        label: row.genusspecies,
        latitude,
        longitude,
        species: row.genusspecies ?? null,
        dbhInches:
          dbhInches !== undefined && Number.isFinite(dbhInches) && dbhInches > 0
            ? dbhInches
            : undefined,
      });
    }
    return features;
  }
}
