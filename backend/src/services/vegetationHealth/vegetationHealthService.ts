// Vegetation health assessment — combines two signals real urban-forestry
// tools actually use (see research: NDVI-based health indices + i-Tree-
// style condition ratings, both tied to real estate value in practice):
//
// 1. Real arborist-assessed condition (NYC Forestry's `tpcondition` field —
//    Good/Fair/Poor, assessed in person by NYC Parks staff, not estimated).
//    This is genuine ground-truth data this app already fetches elsewhere
//    (treeCanopyService.ts) but has never surfaced.
// 2. Species diversity — a simple proxy for ecosystem health/resilience: a
//    monoculture block of one species is more vulnerable to a single pest/
//    disease wiping out the whole canopy than a diverse one. Also ties to
//    the real finding that GVI/biodiversity hotspots correlate with richer
//    microbial diversity (see the earlier "green wellness" research pass).
//
// No caching layer here (unlike the wellness snapshot's Overpass-backed
// Tree Canopy metric) — NYC's Socrata API is fast and not meaningfully
// rate-limited at this request volume, and tree condition genuinely
// doesn't need sub-daily freshness, so a live fetch per request is simpler
// and the "smart" choice here, not a false optimization.

const NYC_FORESTRY_TREE_API_URL = "https://data.cityofnewyork.us/resource/hn5i-inap.json";
const RADIUS_M = 150;

type Condition = "Good" | "Fair" | "Poor";

interface ForestryTreeRow {
  objectid: string;
  tpcondition?: string;
  tpstructure?: string;
  genusspecies?: string;
  location?: { type: "Point"; coordinates: [number, number] };
}

function normalizeCondition(raw: string | undefined): Condition | null {
  const c = raw?.toLowerCase() ?? "";
  if (c.includes("good")) return "Good";
  if (c.includes("fair")) return "Fair";
  if (c.includes("poor") || c.includes("critical") || c.includes("dying")) return "Poor";
  return null;
}

function isLivingTree(row: ForestryTreeRow): boolean {
  const structure = row.tpstructure?.toLowerCase() ?? "";
  return !structure.includes("stump");
}

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
  /** Weighted 0-100: Good=100, Fair=60, Poor=20, averaged across every rated tree. */
  conditionScore: number;
  distinctSpeciesCount: number;
  /** 0-100 — normalized species-diversity signal (see computeDiversityScore). */
  diversityScore: number;
  topSpecies: SpeciesBreakdownEntry[];
  /** conditionScore and diversityScore combined, weighted toward condition (the more concrete, ground-truthed signal). */
  overallScore: number;
  radiusM: number;
  dataSource: string;
}

/**
 * Normalized 0-100 diversity signal: distinct species count relative to
 * total tree count, scaled so a healthy urban mix (roughly 1 distinct
 * species per 3-4 trees, the "10% rule" arborists commonly cite to avoid
 * monoculture risk) lands near the top of the scale, not requiring an
 * unrealistic 1:1 species-to-tree ratio to score well.
 */
function computeDiversityScore(distinctSpeciesCount: number, totalTrees: number): number {
  if (totalTrees === 0) return 0;
  const ratio = distinctSpeciesCount / totalTrees;
  const idealRatio = 0.25; // ~1 species per 4 trees
  return Math.min(100, Math.round((ratio / idealRatio) * 100));
}

export async function computeVegetationHealth(
  latitude: number,
  longitude: number,
  radiusM: number = RADIUS_M
): Promise<VegetationHealthResult> {
  const where = `within_circle(location, ${latitude}, ${longitude}, ${radiusM})`;
  const params = new URLSearchParams({
    $where: where,
    $select: "objectid,tpcondition,tpstructure,genusspecies,location",
    $limit: "5000",
  });
  const response = await fetch(`${NYC_FORESTRY_TREE_API_URL}?${params.toString()}`);
  if (!response.ok) throw new Error(`NYC Forestry API returned ${response.status}`);
  const rows = (await response.json()) as ForestryTreeRow[];

  const living = rows.filter((row) => row.location && isLivingTree(row));

  let goodCount = 0;
  let fairCount = 0;
  let poorCount = 0;
  const speciesCounts = new Map<string, number>();

  for (const row of living) {
    const condition = normalizeCondition(row.tpcondition);
    if (condition === "Good") goodCount++;
    else if (condition === "Fair") fairCount++;
    else if (condition === "Poor") poorCount++;

    const species = row.genusspecies?.trim();
    if (species) speciesCounts.set(species, (speciesCounts.get(species) ?? 0) + 1);
  }

  const ratedTrees = goodCount + fairCount + poorCount;
  const conditionScore =
    ratedTrees === 0 ? 50 : Math.round(((goodCount * 100 + fairCount * 60 + poorCount * 20) / ratedTrees) * 10) / 10;

  const topSpecies = [...speciesCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([species, count]) => ({ species, count }));

  const diversityScore = computeDiversityScore(speciesCounts.size, living.length);
  const overallScore = Math.round((conditionScore * 0.65 + diversityScore * 0.35) * 10) / 10;

  return {
    totalTrees: living.length,
    ratedTrees,
    goodCount,
    fairCount,
    poorCount,
    conditionScore,
    distinctSpeciesCount: speciesCounts.size,
    diversityScore,
    topSpecies,
    overallScore,
    radiusM,
    dataSource: "NYC Parks Forestry Tree Points — field-assessed by arborists",
  };
}
