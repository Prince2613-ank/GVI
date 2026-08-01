import { VegetationFeature } from "../vegetation";
import { VEGETATION_COLORS } from "../../utils/constants";
import { boundingBoxForRadius, haversineDistanceM } from "../../utils/geo";
import { VegetationProvider, VegetationQuery } from "./VegetationProvider";

interface TreeProperties {
  id: string;
  longitude: number;
  latitude: number;
  groundHeight: number;
  treeHeight: number;
  canopyHeight: number;
  crownRadius: number;
  species: string | null;
  heightSource?: "LiDAR";
  heightMethod?: string;
  heightEstimated?: boolean;
}

interface TreeFeature {
  type: "Feature";
  geometry: { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };
  properties: TreeProperties;
}

interface TreeCollection {
  type: "FeatureCollection";
  features: TreeFeature[];
}

function firstOuterRing(feature: TreeFeature): number[][] {
  return feature.geometry.type === "Polygon"
    ? (feature.geometry.coordinates as number[][][])[0]
    : (feature.geometry.coordinates as number[][][][])[0]?.[0] ?? [];
}

/**
 * Loads only backend-processed LiDAR output. LAS/LAZ parsing and crown
 * segmentation are intentionally absent from this browser package.
 */
export class LidarVegetationProvider implements VegetationProvider {
  readonly name = "nyc_lidar";

  constructor(private readonly baseUrl = import.meta.env.VITE_LIDAR_API_URL as string | undefined) {}

  async fetchVegetation(query: VegetationQuery): Promise<VegetationFeature[]> {
    if (!this.baseUrl) {
      // LiDAR is an optional, preferred source. An absent URL means the
      // deployment intentionally uses the NYC Forestry fallback; it is not a
      // partial data-source failure and should not produce a UI warning.
      return [];
    }
    const box = boundingBoxForRadius(query.latitude, query.longitude, query.radiusM);
    const bbox = [box.minLon, box.minLat, box.maxLon, box.maxLat].join(",");
    const response = await fetch(
      `${this.baseUrl.replace(/\/$/, "")}/trees?bbox=${encodeURIComponent(bbox)}`,
      { headers: { Accept: "application/geo+json, application/json" } }
    );
    if (!response.ok) {
      throw new Error(`LiDAR API returned status ${response.status}`);
    }
    const collection = (await response.json()) as TreeCollection;
    return collection.features
      .filter(
        (feature) =>
          haversineDistanceM(
            query.latitude,
            query.longitude,
            feature.properties.latitude,
            feature.properties.longitude
          ) <= query.radiusM
      )
      .map((feature) => ({
        kind: "point" as const,
        id: feature.properties.id,
        source: "nyc_lidar" as const,
        category: "tree" as const,
        color: VEGETATION_COLORS.tree,
        label: feature.properties.species ?? "LiDAR tree",
        latitude: feature.properties.latitude,
        longitude: feature.properties.longitude,
        groundHeight: feature.properties.groundHeight,
        treeHeight: feature.properties.treeHeight,
        heightSource: feature.properties.heightSource ?? ("LiDAR" as const),
        heightMethod:
          feature.properties.heightMethod ?? "Maximum canopy height model (CHM)",
        heightEstimated: feature.properties.heightEstimated ?? false,
        canopyHeight: feature.properties.canopyHeight,
        crownRadius: feature.properties.crownRadius,
        canopyPolygon: firstOuterRing(feature).map(([longitude, latitude]) => ({
          longitude,
          latitude,
        })),
        species: feature.properties.species,
      }));
  }
}
