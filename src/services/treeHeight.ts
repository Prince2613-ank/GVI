import {
  TreeHeightReport,
  TreeHeightSource,
  VegetationFeature,
  VegetationPoint,
} from "./vegetation";

export const DEFAULT_TREE_HEIGHT_M = 8;
const MIN_VALID_HEIGHT_M = 1.5;
// 70m (the previous cap) is far above anything a real, sidewalk-constrained
// street tree reaches — the tallest species in SPECIES_MATURE_HEIGHT_M below
// tops out at 30m (London planetree). LiDAR-derived canopy-height-model
// (CHM) data is a known failure mode near buildings: if a tree's canopy
// pixel sits close to a building, LiDAR returns off the building's roof/
// wall can get attributed to that pixel, producing a "tree height" that's
// actually the adjacent building's height. Those inflated values were
// sailing through as "valid" and rendering the tree's crown up at
// building-wall height instead of near the ground. Capping just above the
// tallest realistic species (with a small margin) rejects those
// building-contaminated readings so they fall through to the
// species/DBH-based estimate or the 8m default instead.
const MAX_VALID_HEIGHT_M = 32;

const SPECIES_MATURE_HEIGHT_M: Array<[RegExp, number]> = [
  [/london planetree|sycamore/i, 30],
  [/\boak\b/i, 27],
  [/\belm\b/i, 25],
  [/linden|basswood/i, 24],
  [/maple/i, 22],
  [/honeylocust|honey locust/i, 21],
  [/ginkgo/i, 20],
  [/zelkova/i, 20],
  [/ash/i, 23],
  [/sweetgum/i, 24],
  [/cherry/i, 16],
  [/callery pear|\bpear\b/i, 13],
  [/crab apple|crabapple/i, 10],
  [/redbud/i, 9],
];

export function isValidTreeHeight(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_VALID_HEIGHT_M &&
    value <= MAX_VALID_HEIGHT_M
  );
}

function matureHeightForSpecies(species?: string | null): number | undefined {
  if (!species) return undefined;
  return SPECIES_MATURE_HEIGHT_M.find(([pattern]) => pattern.test(species))?.[1];
}

function estimateHeight(
  dbhInches?: number,
  species?: string | null
): { height: number; method: string } | null {
  const matureHeight = matureHeightForSpecies(species) ?? 22;
  if (dbhInches !== undefined && Number.isFinite(dbhInches) && dbhInches > 0) {
    const dbhCm = dbhInches * 2.54;
    // Saturating urban-tree allometry: breast-height diameter controls age/
    // size, while species mature height prevents implausible extrapolation.
    const height =
      1.37 +
      (matureHeight - 1.37) *
        (1 - Math.exp(-dbhCm / (matureHeight * 2.2)));
    return {
      height: Math.min(MAX_VALID_HEIGHT_M, Math.max(MIN_VALID_HEIGHT_M, height)),
      method: species
        ? `DBH (${dbhInches.toFixed(1)} in) + species allometry`
        : `DBH (${dbhInches.toFixed(1)} in) generic allometry`,
    };
  }
  if (species && matureHeightForSpecies(species)) {
    return {
      height: Math.max(MIN_VALID_HEIGHT_M, matureHeight * 0.55),
      method: "species typical-height estimate (DBH unavailable)",
    };
  }
  return null;
}

function resolveTree(tree: VegetationPoint): VegetationPoint {
  if (tree.source === "nyc_lidar" && isValidTreeHeight(tree.treeHeight)) {
    return {
      ...tree,
      heightSource: "LiDAR",
      heightMethod: "Maximum canopy height model (CHM)",
      heightEstimated: false,
    };
  }
  if (
    (tree.heightSource === "Estimated" || tree.heightSource === "Measured") &&
    isValidTreeHeight(tree.treeHeight)
  ) {
    return tree;
  }

  const estimate = estimateHeight(tree.dbhInches, tree.species ?? tree.label);
  if (estimate) {
    return {
      ...tree,
      treeHeight: Number(estimate.height.toFixed(2)),
      heightSource: "Estimated",
      heightMethod: estimate.method,
      heightEstimated: true,
    };
  }

  console.warn("[Tree height] Missing/invalid height; applying explicit default", {
    id: tree.id,
    source: tree.source,
    receivedHeight: tree.treeHeight,
    species: tree.species ?? tree.label ?? null,
    dbhInches: tree.dbhInches ?? null,
  });
  return {
    ...tree,
    treeHeight: DEFAULT_TREE_HEIGHT_M,
    heightSource: "Default",
    heightMethod: "8 m fallback: no valid LiDAR height, DBH, or known species",
    heightEstimated: true,
  };
}

export function resolveTreeHeights(features: VegetationFeature[]): VegetationFeature[] {
  return features.map((feature) => {
    if (
      feature.kind !== "point" ||
      (feature.category !== "tree" && feature.category !== "street_tree")
    ) {
      return feature;
    }
    return resolveTree(feature);
  });
}

export function buildTreeHeightReport(
  features: VegetationFeature[]
): TreeHeightReport {
  const trees = features.filter(
    (feature): feature is VegetationPoint =>
      feature.kind === "point" &&
      (feature.category === "tree" || feature.category === "street_tree")
  );
  const count = (source: TreeHeightSource) =>
    trees.filter((tree) => tree.heightSource === source).length;
  return {
    total: trees.length,
    lidar: count("LiDAR"),
    measured: count("Measured"),
    estimated: count("Estimated"),
    defaults: count("Default"),
    invalid: trees.filter((tree) => !isValidTreeHeight(tree.treeHeight)).length,
  };
}
