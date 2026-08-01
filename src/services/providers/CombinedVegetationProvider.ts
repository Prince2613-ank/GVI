import { VegetationFeature } from "../vegetation";
import { VegetationProvider, VegetationQuery } from "./VegetationProvider";
import { OverpassProvider } from "./OverpassProvider";
import { NYCStreetTreeProvider } from "./NYCStreetTreeProvider";
import { LidarVegetationProvider } from "./LidarVegetationProvider";
import { haversineDistanceM } from "../../utils/geo";

const TREE_DEDUPLICATION_DISTANCE_M = 2.5;

function isTreeFeature(feature: VegetationFeature): boolean {
  return (
    feature.kind === "point" &&
    (feature.category === "tree" || feature.category === "street_tree")
  );
}

/**
 * Keeps the higher-quality source when two inventories describe the same
 * physical tree, while retaining OSM-only trees that the local inventory
 * missed. Input order defines priority: LiDAR, field census, then OSM.
 *
 * A duplicate's fields are not simply discarded: species/DBH gaps on the
 * kept record are backfilled from the lower-priority match (never
 * overwriting a value the kept record already has). This matters for
 * canopy-polygon estimation (services/canopy.ts) — a LiDAR tree with real
 * crown geometry but no species, and a Forestry record for the same tree
 * with species+DBH but no crown data, should end up as one record with
 * both, not two independent partial ones where the better data is thrown
 * away.
 */
function mergeUniqueTrees(groups: VegetationFeature[][]): VegetationFeature[] {
  const merged: VegetationFeature[] = [];
  for (const group of groups) {
    for (const feature of group) {
      if (!isTreeFeature(feature) || feature.kind !== "point") continue;
      const duplicateIndex = merged.findIndex(
        (existing) =>
          existing.kind === "point" &&
          haversineDistanceM(
            existing.latitude,
            existing.longitude,
            feature.latitude,
            feature.longitude
          ) <= TREE_DEDUPLICATION_DISTANCE_M
      );
      if (duplicateIndex === -1) {
        merged.push(feature);
        continue;
      }
      const existing = merged[duplicateIndex];
      if (existing.kind !== "point") continue;
      const existingHasRealHeight =
        existing.heightSource === "LiDAR" || existing.heightSource === "Measured";
      merged[duplicateIndex] = {
        ...existing,
        species: existing.species ?? feature.species,
        dbhInches: existing.dbhInches ?? feature.dbhInches,
        label: existing.label ?? feature.label,
        // A real field/OSM measurement on the lower-priority match should
        // still win over the kept record having no height/crown data at
        // all — only ever backfilling gaps, never overwriting a real value
        // the kept record (LiDAR or an earlier Measured match) already has.
        ...(!existingHasRealHeight && feature.heightSource === "Measured"
          ? {
              treeHeight: feature.treeHeight,
              heightSource: feature.heightSource,
              heightMethod: feature.heightMethod,
              heightEstimated: feature.heightEstimated,
            }
          : {}),
        crownRadius: existing.crownRadius ?? feature.crownRadius,
      };
    }
  }
  return merged;
}

// CombinedVegetationProvider merges results from multiple sources — by
// default the current NYC Forestry inventory (street and park trees) and
// Overpass (parks, forests, woods, grassland, scrub) — into one feature
// list. A single source failing (e.g. Overpass rate-limited) doesn't blank
// out the whole layer; it's only fatal if every provider fails. Partial
// failures are logged and recorded on `lastPartialFailures` so a source
// silently returning nothing (e.g. one API down) is diagnosable instead of
// looking like "0 features found" from a data gap.

export class CombinedVegetationProvider implements VegetationProvider {
  readonly name = "combined";

  /** Failure messages from the most recent fetchVegetation call, if any providers failed. */
  lastPartialFailures: string[] = [];

  private readonly lidarProvider: VegetationProvider;
  private readonly fallbackTreeProvider: VegetationProvider;
  private readonly landcoverProvider: VegetationProvider;

  constructor(
    lidarProvider: VegetationProvider = new LidarVegetationProvider(),
    fallbackTreeProvider: VegetationProvider = new NYCStreetTreeProvider(),
    landcoverProvider: VegetationProvider = new OverpassProvider()
  ) {
    this.lidarProvider = lidarProvider;
    this.fallbackTreeProvider = fallbackTreeProvider;
    this.landcoverProvider = landcoverProvider;
  }

  async fetchVegetation(query: VegetationQuery): Promise<VegetationFeature[]> {
    // Fetch every available inventory. The merge below keeps LiDAR/census
    // quality where sources overlap while retaining OSM-only mapped trees.
    const [lidarResult, fallbackResult, landcoverResult] = await Promise.allSettled([
      this.lidarProvider.fetchVegetation(query),
      this.fallbackTreeProvider.fetchVegetation(query),
      this.landcoverProvider.fetchVegetation(query),
    ]);
    const failures: string[] = [];
    if (lidarResult.status === "rejected") {
      failures.push(
        `${this.lidarProvider.name}: ${
          lidarResult.reason instanceof Error ? lidarResult.reason.message : String(lidarResult.reason)
        }`
      );
    }
    if (fallbackResult.status === "rejected") {
      failures.push(
        `${this.fallbackTreeProvider.name}: ${
          fallbackResult.reason instanceof Error
            ? fallbackResult.reason.message
            : String(fallbackResult.reason)
        }`
      );
    }
    const lidarTrees = lidarResult.status === "fulfilled" ? lidarResult.value : [];
    const inventoryTrees =
      fallbackResult.status === "fulfilled" ? fallbackResult.value : [];
    const overpassTrees =
      landcoverResult.status === "fulfilled"
        ? landcoverResult.value.filter(isTreeFeature)
        : [];
    const treeFeatures = mergeUniqueTrees([
      lidarTrees,
      inventoryTrees,
      overpassTrees,
    ]);
    let landcoverFeatures: VegetationFeature[] = [];
    if (landcoverResult.status === "fulfilled") {
      landcoverFeatures = landcoverResult.value.filter(
        (feature) => feature.category !== "tree" && feature.category !== "street_tree"
      );
    } else {
      failures.push(
        `${this.landcoverProvider.name}: ${
          landcoverResult.reason instanceof Error
            ? landcoverResult.reason.message
            : String(landcoverResult.reason)
        }`
      );
    }
    const features = [...treeFeatures, ...landcoverFeatures];

    this.lastPartialFailures = failures;

    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`Vegetation provider(s) failed: ${failures.join("; ")}`);
    }

    if (features.length === 0 && failures.length > 0) {
      throw new Error(`All vegetation providers failed — ${failures.join("; ")}`);
    }

    return features;
  }
}
