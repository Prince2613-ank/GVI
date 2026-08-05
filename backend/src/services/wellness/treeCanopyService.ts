import { runOverpassQuery, elementLatLon, haversineDistanceM } from "./overpassClient";

const CANOPY_RADIUS_M = 150;
// Typical mature street-tree canopy spread radius (meters) — fallback for
// trees with no measured trunk diameter to derive a real crown estimate
// from (Overpass rarely has DBH; NYC Forestry usually does).
const DEFAULT_CANOPY_RADIUS_M = 3.5;
// Two source points within this distance are treated as the same physical
// tree (NYC Forestry's official inventory and OSM's crowdsourced tree tags
// frequently both cover the same street trees) — without this, overlap
// between the two sources would double-count canopy area.
const DEDUP_DISTANCE_M = 6;

const NYC_FORESTRY_TREE_API_URL = "https://data.cityofnewyork.us/resource/hn5i-inap.json";

interface ForestryTreeRow {
  objectid: string;
  dbh?: string;
  tpstructure?: string;
  tpcondition?: string;
  location?: { type: "Point"; coordinates: [number, number] };
}

interface CanopyTree {
  latitude: number;
  longitude: number;
  /** Crown radius in meters — derived from measured trunk diameter (NYC Forestry) where available, otherwise DEFAULT_CANOPY_RADIUS_M. */
  crownRadiusM: number;
  source: "nyc_forestry" | "overpass";
}

function isLivingTree(row: ForestryTreeRow): boolean {
  const structure = row.tpstructure?.toLowerCase() ?? "";
  const condition = row.tpcondition?.toLowerCase() ?? "";
  return !structure.includes("stump") && !condition.includes("dead");
}

/** Rough, widely-used allometric approximation: crown spread (ft) ≈ trunk diameter (in) × a species-average multiplier — converted to meters. Better than a flat assumption when real trunk-diameter data exists, still just an estimate. */
function crownRadiusFromDbhInches(dbhInches: number): number {
  const crownDiameterFt = dbhInches * 1.5;
  const crownDiameterM = crownDiameterFt * 0.3048;
  return Math.max(1.5, crownDiameterM / 2);
}

async function fetchNycForestryTrees(
  latitude: number,
  longitude: number,
  radiusM: number
): Promise<CanopyTree[]> {
  const where = `within_circle(location, ${latitude}, ${longitude}, ${radiusM})`;
  const params = new URLSearchParams({
    $where: where,
    $select: "objectid,dbh,tpstructure,tpcondition,location",
    $limit: "5000",
  });
  const response = await fetch(`${NYC_FORESTRY_TREE_API_URL}?${params.toString()}`);
  if (!response.ok) throw new Error(`NYC Forestry API returned ${response.status}`);
  const rows = (await response.json()) as ForestryTreeRow[];

  const trees: CanopyTree[] = [];
  for (const row of rows) {
    if (!row.location || !isLivingTree(row)) continue;
    const [lon, lat] = row.location.coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const dbh = row.dbh ? Number(row.dbh) : undefined;
    trees.push({
      latitude: lat,
      longitude: lon,
      crownRadiusM:
        dbh !== undefined && Number.isFinite(dbh) && dbh > 0
          ? crownRadiusFromDbhInches(dbh)
          : DEFAULT_CANOPY_RADIUS_M,
      source: "nyc_forestry",
    });
  }
  return trees;
}

async function fetchOverpassTrees(
  latitude: number,
  longitude: number,
  radiusM: number
): Promise<CanopyTree[]> {
  const query = `
    [out:json][timeout:15];
    (
      node["natural"="tree"](around:${radiusM},${latitude},${longitude});
    );
    out center;
  `;
  const elements = await runOverpassQuery(query);
  const trees: CanopyTree[] = [];
  for (const el of elements) {
    const pos = elementLatLon(el);
    if (!pos) continue;
    trees.push({
      latitude: pos.lat,
      longitude: pos.lon,
      crownRadiusM: DEFAULT_CANOPY_RADIUS_M,
      source: "overpass",
    });
  }
  return trees;
}

/** Drops Overpass trees that are just the same physical tree NYC Forestry already counted, so overlapping coverage between the two sources doesn't double the canopy estimate. */
function dedupeAgainstForestry(forestryTrees: CanopyTree[], overpassTrees: CanopyTree[]): CanopyTree[] {
  return overpassTrees.filter(
    (ot) =>
      !forestryTrees.some(
        (ft) => haversineDistanceM(ot.latitude, ot.longitude, ft.latitude, ft.longitude) < DEDUP_DISTANCE_M
      )
  );
}

export interface TreeCanopyResult {
  treeCount: number;
  nycForestryCount: number;
  overpassOnlyCount: number;
  estimatedCanopyCoveragePct: number;
  radiusM: number;
}

/**
 * Combines NYC's official Forestry Tree Points inventory (real trunk-
 * diameter measurements where available, so crown size is derived, not
 * assumed) with OpenStreetMap's crowdsourced tree tags (broader coverage —
 * catches trees on private/landscaped land NYC's public-realm inventory
 * doesn't track), deduplicated against each other, then converts the
 * combined tree set into an approximate canopy coverage % the same way a
 * single-source estimate would — just with a materially better underlying
 * tree count and per-tree size than Overpass alone.
 */
export async function computeTreeCanopy(
  latitude: number,
  longitude: number,
  radiusM: number = CANOPY_RADIUS_M
): Promise<TreeCanopyResult> {
  const [nycTrees, overpassTreesRaw] = await Promise.all([
    fetchNycForestryTrees(latitude, longitude, radiusM).catch((error) => {
      // eslint-disable-next-line no-console
      console.warn("[Wellness] NYC Forestry tree lookup failed; continuing with Overpass only", error);
      return [] as CanopyTree[];
    }),
    fetchOverpassTrees(latitude, longitude, radiusM),
  ]);

  const overpassOnly = dedupeAgainstForestry(nycTrees, overpassTreesRaw);
  const allTrees = [...nycTrees, ...overpassOnly];

  const searchAreaM2 = Math.PI * radiusM ** 2;
  const totalCanopyAreaM2 = allTrees.reduce(
    (sum, tree) => sum + Math.PI * tree.crownRadiusM ** 2,
    0
  );
  const estimatedCanopyCoveragePct = Math.min(100, (totalCanopyAreaM2 * 100) / searchAreaM2);

  return {
    treeCount: allTrees.length,
    nycForestryCount: nycTrees.length,
    overpassOnlyCount: overpassOnly.length,
    estimatedCanopyCoveragePct,
    radiusM,
  };
}
