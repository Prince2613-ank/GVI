// vegetation.ts holds the shared vegetation domain model: the feature
// shapes every provider produces, and the summary math the UI consumes.
// Provider-specific parsing (Overpass tags, NYC Socrata rows, ...) lives in
// src/services/providers/*, not here — this file has no HTTP knowledge.

export type VegetationSource = "overpass" | "nyc_forestry" | "nyc_lidar";
/** Field-assessed tree condition, as recorded by a city forestry inventory. */
export type TreeCondition = "Good" | "Fair" | "Poor";
export type TreeHeightSource = "LiDAR" | "Measured" | "Estimated" | "Default";

export interface TreeHeightReport {
  total: number;
  lidar: number;
  measured: number;
  estimated: number;
  defaults: number;
  invalid: number;
}

/**
 * Priority order used by services/canopy.ts when building each tree's
 * canopy polygon: a real LiDAR-segmented crown always wins, then a real
 * polygon from any other API (none currently supplies one), then a circle
 * derived from a measured crown radius, then a species-typical ellipse, and
 * only as a last resort an unscientific fixed-size circle.
 */
export type CanopySource =
  | "lidar_polygon"
  | "api_polygon"
  | "crown_radius_circle"
  | "species_ellipse"
  | "circle_fallback";

export interface CanopyReport {
  total: number;
  lidarPolygon: number;
  apiPolygon: number;
  crownRadiusCircle: number;
  speciesEllipse: number;
  circleFallback: number;
  avgCanopyAreaM2: number;
  avgCrownDiameterM: number;
}

export type VegetationCategory =
  | "tree"
  | "street_tree"
  | "wood"
  | "forest"
  | "park"
  | "scrub"
  | "grassland";

interface VegetationFeatureBase {
  /** Globally unique across all providers (prefixed by source). */
  id: string;
  source: VegetationSource;
  category: VegetationCategory;
  color: string;
  /** Optional human-readable label (species name, park name, ...). */
  label?: string;
}

export interface VegetationPoint extends VegetationFeatureBase {
  kind: "point";
  latitude: number;
  longitude: number;
  /** LiDAR-derived elevations and crown metrics, in meters. */
  groundHeight?: number;
  treeHeight?: number;
  canopyHeight?: number;
  crownRadius?: number;
  canopyPolygon?: { latitude: number; longitude: number }[];
  species?: string | null;
  /** Diameter at breast height from a field inventory, in inches. */
  dbhInches?: number;
  /**
   * Arborist-assessed condition from a field inventory (NYC Forestry's
   * `tpcondition`). Real observed data, not inferred — drives how full and
   * how healthy-coloured the rendered canopy is, so a declining tree isn't
   * drawn as lush as a thriving one.
   */
  condition?: TreeCondition;
  heightSource?: TreeHeightSource;
  heightMethod?: string;
  heightEstimated?: boolean;
  /** Which tier of the canopy-polygon priority chain produced this tree's shape. */
  canopySource?: CanopySource;
  canopyAreaM2?: number;
  crownDiameterM?: number;
}

export interface VegetationPolygon extends VegetationFeatureBase {
  kind: "polygon";
  positions: { latitude: number; longitude: number }[];
}

export type VegetationFeature = VegetationPoint | VegetationPolygon;

export interface VegetationSummary {
  features: VegetationFeature[];
  counts: Record<VegetationCategory, number>;
  bySource: Record<VegetationSource, number>;
  totalTrees: number;
  totalParks: number;
  totalForests: number;
  heightReport: TreeHeightReport;
  canopyReport: CanopyReport;
}

/** Aggregates a merged feature list (from any provider mix) into UI-ready counts. */
export function summarizeVegetation(features: VegetationFeature[]): VegetationSummary {
  // Imported lazily at module level would create a vegetation <-> treeHeight
  // cycle, so height counts are computed directly from normalized features.
  const treeFeatures = features.filter(
    (feature): feature is VegetationPoint =>
      feature.kind === "point" &&
      (feature.category === "tree" || feature.category === "street_tree")
  );
  const counts: Record<VegetationCategory, number> = {
    tree: 0,
    street_tree: 0,
    wood: 0,
    forest: 0,
    park: 0,
    scrub: 0,
    grassland: 0,
  };
  const bySource: Record<VegetationSource, number> = {
    overpass: 0,
    nyc_forestry: 0,
    nyc_lidar: 0,
  };

  for (const feature of features) {
    counts[feature.category]++;
    bySource[feature.source]++;
  }

  return {
    features,
    counts,
    bySource,
    totalTrees: counts.tree + counts.street_tree,
    totalParks: counts.park,
    totalForests: counts.forest + counts.wood,
    heightReport: {
      total: treeFeatures.length,
      lidar: treeFeatures.filter((tree) => tree.heightSource === "LiDAR").length,
      measured: treeFeatures.filter((tree) => tree.heightSource === "Measured").length,
      estimated: treeFeatures.filter((tree) => tree.heightSource === "Estimated").length,
      defaults: treeFeatures.filter((tree) => tree.heightSource === "Default").length,
      invalid: treeFeatures.filter(
        (tree) =>
          typeof tree.treeHeight !== "number" ||
          !Number.isFinite(tree.treeHeight) ||
          tree.treeHeight <= 0
      ).length,
    },
    canopyReport: buildCanopyReportInline(treeFeatures),
  };
}

// Computed inline (not imported from services/canopy.ts) to avoid a
// vegetation <-> canopy import cycle, mirroring the heightReport approach
// above. services/canopy.ts re-exports buildCanopyReport for callers that
// want it directly without going through summarizeVegetation.
function buildCanopyReportInline(trees: VegetationPoint[]): CanopyReport {
  const count = (source: CanopySource) =>
    trees.filter((tree) => tree.canopySource === source).length;
  const withArea = trees.filter(
    (tree) => typeof tree.canopyAreaM2 === "number" && Number.isFinite(tree.canopyAreaM2)
  );
  const withDiameter = trees.filter(
    (tree) => typeof tree.crownDiameterM === "number" && Number.isFinite(tree.crownDiameterM)
  );
  const avg = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    total: trees.length,
    lidarPolygon: count("lidar_polygon"),
    apiPolygon: count("api_polygon"),
    crownRadiusCircle: count("crown_radius_circle"),
    speciesEllipse: count("species_ellipse"),
    circleFallback: count("circle_fallback"),
    avgCanopyAreaM2: avg(withArea.map((t) => t.canopyAreaM2 as number)),
    avgCrownDiameterM: avg(withDiameter.map((t) => t.crownDiameterM as number)),
  };
}
