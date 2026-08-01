import * as Cesium from "cesium";
import { VegetationCategory } from "../../services/vegetation";
import { RayResult } from "./RayCastingEngine";
import { GreenClass, RayClassification, SurfaceClass } from "./types";

// Classifies what a single ray hit into the surface taxonomy the spec asks
// for. This app's existing data model only carries real per-feature
// identity for vegetation (see gis/TreeRenderer.ts + gis/VegetationLayer.ts
// id/prefix scheme) and buildings (our placed GLB + Cesium OSM Buildings
// tiles) — there is no dedicated road or water layer loaded anywhere in
// this codebase. Hits on bare terrain/globe with no vegetation or building
// match are therefore honestly reported as "unknown" rather than guessed
// as road/water; wire in a real road/water dataset and extend
// classifyHit's terrain branch to get real Road/Water classification.

function mapVegetationCategory(category: VegetationCategory): GreenClass {
  switch (category) {
    case "tree":
    case "street_tree":
    case "wood":
    case "forest":
      return "tree";
    case "scrub":
      return "bush";
    case "park":
      return "park";
    case "grassland":
      return "grass";
  }
}

/** Pulls a comparable string id out of a Cesium pick result's `object`,
 * whether it's a raw primitive id, an Entity, or nested under `.primitive`. */
function extractPickId(object: unknown): string | undefined {
  if (!object || typeof object !== "object") return undefined;
  const candidate = object as { id?: unknown; primitive?: { id?: unknown } };
  const normalize = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value instanceof Cesium.Entity) return value.id;
    if (value && typeof value === "object" && "id" in value) {
      const nested = (value as { id?: unknown }).id;
      if (typeof nested === "string") return nested;
    }
    return undefined;
  };
  return normalize(candidate.id) ?? normalize(candidate.primitive?.id);
}

function isOsmBuildingFeature(object: unknown): boolean {
  // Cesium3DTileFeature instances (OSM Buildings, or any 3D Tiles layer)
  // carry getProperty/getPropertyIds, which plain Entities/primitives don't.
  return (
    !!object &&
    typeof object === "object" &&
    typeof (object as { getProperty?: unknown }).getProperty === "function"
  );
}

export interface ClassifierContext {
  /** Vegetation feature id -> category, built by the caller from the
   * current VegetationSummary (see App.tsx's `summary` state). */
  vegetationCategoryById: Map<string, VegetationCategory>;
  /** The placed building's own entity, so self-hits classify as "building"
   * rather than "unknown". */
  buildingEntity: Cesium.Entity | null;
}

export function classifyHit(hit: RayResult, context: ClassifierContext): RayClassification {
  if (!hit.hitPosition) {
    return { classSurface: "sky", isGreen: false, distanceM: null };
  }

  const pickId = extractPickId(hit.hitObject);

  if (pickId) {
    // TreeRenderer prefixes crown/trunk entity ids; canopy GroundPrimitive
    // geometry instances and point markers use the bare vegetation feature id.
    const baseId = pickId.replace(/^(crown|trunk)-/, "");
    const category = context.vegetationCategoryById.get(baseId);
    if (category) {
      const classSurface = mapVegetationCategory(category);
      return { classSurface, isGreen: true, distanceM: hit.distanceM };
    }

    if (context.buildingEntity && pickId === context.buildingEntity.id) {
      return { classSurface: "building", isGreen: false, distanceM: hit.distanceM };
    }
  }

  if (isOsmBuildingFeature(hit.hitObject)) {
    return { classSurface: "building", isGreen: false, distanceM: hit.distanceM };
  }

  // Bare terrain/globe hit with no matched feature: no road/water layer
  // exists in this app to classify further (see file header comment).
  return { classSurface: "unknown", isGreen: false, distanceM: hit.distanceM };
}

export function classifyBatch(
  hits: RayResult[],
  context: ClassifierContext
): RayClassification[] {
  return hits.map((hit) => classifyHit(hit, context));
}

export function summarizeClassCounts(
  classifications: RayClassification[]
): Record<SurfaceClass, number> {
  const counts: Record<SurfaceClass, number> = {
    tree: 0,
    grass: 0,
    bush: 0,
    park: 0,
    building: 0,
    road: 0,
    water: 0,
    sky: 0,
    unknown: 0,
  };
  for (const c of classifications) {
    counts[c.classSurface]++;
  }
  return counts;
}
