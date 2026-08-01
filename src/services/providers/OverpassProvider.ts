import { fetchVegetationRaw, OverpassElement } from "../overpass";
import { VegetationCategory, VegetationFeature } from "../vegetation";
import { VEGETATION_COLORS } from "../../utils/constants";
import { VegetationProvider, VegetationQuery } from "./VegetationProvider";

// OverpassProvider sources area-based vegetation from OpenStreetMap via the
// Overpass API: parks, forests, woods, scrub, and grassland polygons. See
// overpass.ts for the raw HTTP query — this class only shapes that response
// into the shared VegetationFeature model.

function categorizeTags(
  tags: Record<string, string>
): VegetationCategory | null {
  if (tags.natural === "tree" || tags.natural === "tree_row") return "tree";
  if (tags.natural === "wood") return "wood";
  if (
    tags.landuse === "forest" ||
    tags.landuse === "orchard" ||
    tags.landcover === "trees"
  ) return "forest";
  if (tags.leisure === "park") return "park";
  if (
    tags.leisure === "garden" ||
    tags.landuse === "grass" ||
    tags.landuse === "meadow"
  ) return "grassland";
  if (
    tags.natural === "shrub" ||
    tags.natural === "scrub" ||
    tags.natural === "shrubbery" ||
    tags.natural === "heath" ||
    tags.landcover === "shrub"
  ) {
    return "scrub";
  }
  if (tags.natural === "grassland") return "grassland";
  return null;
}

/** Parses an OSM numeric tag that may carry a unit suffix, e.g. "12.5 m" or "12.5". */
function parseMeters(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^([\d.]+)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function pointFeature(
  el: OverpassElement,
  category: VegetationCategory,
  latitude: number,
  longitude: number
): VegetationFeature {
  // OSM tree nodes often carry real field measurements directly — pull
  // them so downstream height/canopy code (treeHeight.ts, canopy.ts) uses
  // actual surveyed data instead of falling back to species/DBH estimates.
  const measuredHeightM = parseMeters(el.tags?.height);
  const crownDiameterM = parseMeters(el.tags?.diameter_crown);
  // circumference is trunk girth in meters; DBH (inches) = circumference / (pi * 0.0254).
  const circumferenceM = parseMeters(el.tags?.circumference);
  const dbhFromCircumference = circumferenceM
    ? circumferenceM / (Math.PI * 0.0254)
    : undefined;

  return {
    kind: "point",
    id: `overpass-${el.type}-${el.id}`,
    source: "overpass",
    category,
    color: VEGETATION_COLORS[category],
    label: el.tags?.name ?? el.tags?.species ?? el.tags?.genus,
    latitude,
    longitude,
    species: el.tags?.species ?? el.tags?.genus ?? null,
    ...(measuredHeightM !== undefined
      ? { treeHeight: measuredHeightM, heightSource: "Measured" as const, heightMethod: "OSM height tag", heightEstimated: false }
      : {}),
    ...(crownDiameterM !== undefined ? { crownRadius: crownDiameterM / 2 } : {}),
    ...(dbhFromCircumference !== undefined ? { dbhInches: dbhFromCircumference } : {}),
  };
}

function samePosition(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): boolean {
  return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
}

/** Joins split multipolygon member ways and rejects open accidental shapes. */
function stitchClosedRings(
  segments: { lat: number; lon: number }[][]
): { lat: number; lon: number }[][] {
  const remaining = segments.filter((segment) => segment.length >= 2).map((segment) => [...segment]);
  const rings: { lat: number; lon: number }[][] = [];

  while (remaining.length > 0) {
    const chain = remaining.shift()!;
    while (!samePosition(chain[0], chain[chain.length - 1])) {
      const end = chain[chain.length - 1];
      const nextIndex = remaining.findIndex(
        (segment) =>
          samePosition(segment[0], end) ||
          samePosition(segment[segment.length - 1], end)
      );
      if (nextIndex < 0) break;
      const next = remaining.splice(nextIndex, 1)[0];
      if (samePosition(next[next.length - 1], end)) next.reverse();
      chain.push(...next.slice(1));
    }
    if (chain.length >= 4 && samePosition(chain[0], chain[chain.length - 1])) {
      rings.push(chain);
    }
  }
  return rings;
}

function toFeatures(el: OverpassElement): VegetationFeature[] {
  if (!el.tags) return [];
  const category = categorizeTags(el.tags);
  if (!category) return [];

  const color = VEGETATION_COLORS[category];
  const label = el.tags.name;
  const id = `overpass-${el.type}-${el.id}`;

  if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
    return [pointFeature(el, category, el.lat, el.lon)];
  }

  if (el.geometry && el.geometry.length > 0) {
    if (el.tags.natural === "tree_row") {
      return el.geometry.map((position, index) => ({
        ...pointFeature(el, "tree", position.lat, position.lon),
        id: `${id}-vertex-${index}`,
      }));
    }
    return [{
      kind: "polygon",
      id,
      source: "overpass",
      category,
      color,
      label,
      positions: el.geometry.map((p) => ({ latitude: p.lat, longitude: p.lon })),
    }];
  }

  const outerRings = stitchClosedRings(
    (el.members ?? [])
      .filter((member) => member.type === "way" && member.role !== "inner")
      .map((member) => member.geometry ?? [])
  );
  if (outerRings.length > 0) {
    return outerRings.map((ring, index) => ({
      kind: "polygon",
      id: `${id}-outer-${index}`,
      source: "overpass",
      category,
      color,
      label,
      positions: ring.map((p) => ({ latitude: p.lat, longitude: p.lon })),
    }));
  }

  // Never turn an area relation with missing geometry into an arbitrary
  // green circle. A center fallback is meaningful only for a mapped tree.
  if (el.center) {
    return category === "tree"
      ? [pointFeature(el, category, el.center.lat, el.center.lon)]
      : [];
  }

  return [];
}

export class OverpassProvider implements VegetationProvider {
  readonly name = "overpass";

  async fetchVegetation(query: VegetationQuery): Promise<VegetationFeature[]> {
    const elements = await fetchVegetationRaw(
      query.latitude,
      query.longitude,
      query.radiusM
    );

    const features: VegetationFeature[] = [];
    for (const el of elements) {
      features.push(...toFeatures(el));
    }
    return features;
  }
}
