// Crown-diameter allometry, structured to mirror treeHeight.ts exactly:
// species+DBH first, species-typical spread second, null (caller falls
// back further) last. Used by services/canopy.ts to size the "species
// ellipse" tier of the canopy-polygon priority chain — never a single
// fixed radius.

const MIN_VALID_CROWN_DIAMETER_M = 1;
const MAX_VALID_CROWN_DIAMETER_M = 35;

export const DEFAULT_CROWN_DIAMETER_M = 7;

// Typical mature crown spread (meters) per genus/species, loosely from
// urban-forestry street-tree references. Keyed the same way as
// treeHeight.ts's SPECIES_MATURE_HEIGHT_M so the two tables stay easy to
// cross-check against each other.
const SPECIES_CROWN_DIAMETER_M: Array<[RegExp, number]> = [
  [/london planetree|sycamore/i, 15],
  [/\boak\b/i, 14],
  [/\belm\b/i, 13],
  [/linden|basswood/i, 11],
  [/maple/i, 11],
  [/honeylocust|honey locust/i, 10],
  [/ginkgo/i, 9],
  [/zelkova/i, 10],
  [/ash/i, 11],
  [/sweetgum/i, 10],
  [/cherry/i, 8],
  [/callery pear|\bpear\b/i, 7],
  [/crab apple|crabapple/i, 6],
  [/redbud/i, 5],
];

// Width:depth ratio for the generated ellipse. Most street-tree crowns are
// close enough to circular that we default to 1.0; a couple of genera with
// notably narrower/columnar habits get a documented adjustment. This is a
// simplification, not a measurement of real crown orientation (there's no
// wind/street-alignment data available) — see the plan's Risks section.
const SPECIES_CROWN_ASPECT_RATIO: Array<[RegExp, number]> = [
  [/\belm\b/i, 0.75],
  [/columnar|fastigiate|pyramidal/i, 0.6],
];

export function isValidCrownDiameter(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_VALID_CROWN_DIAMETER_M &&
    value <= MAX_VALID_CROWN_DIAMETER_M
  );
}

function matureCrownDiameterForSpecies(species?: string | null): number | undefined {
  if (!species) return undefined;
  return SPECIES_CROWN_DIAMETER_M.find(([pattern]) => pattern.test(species))?.[1];
}

function aspectRatioForSpecies(species?: string | null): number {
  if (!species) return 1;
  return SPECIES_CROWN_ASPECT_RATIO.find(([pattern]) => pattern.test(species))?.[1] ?? 1;
}

export interface CrownDiameterEstimate {
  diameterM: number;
  aspectRatio: number;
  method: string;
}

/**
 * Estimates crown (canopy) diameter, mirroring treeHeight.ts's
 * estimateHeight: DBH + species allometry first (crown spread grows with
 * trunk diameter, saturating at the species' mature spread), then a
 * species-typical spread scaled down for an immature tree using treeHeight
 * as a maturity proxy, then null if neither DBH nor species is known
 * (caller falls back to the last-resort fixed circle).
 */
export function estimateCrownDiameter(
  dbhInches?: number,
  species?: string | null,
  treeHeight?: number
): CrownDiameterEstimate | null {
  const matureDiameter = matureCrownDiameterForSpecies(species) ?? DEFAULT_CROWN_DIAMETER_M * 1.5;
  const aspectRatio = aspectRatioForSpecies(species);

  if (dbhInches !== undefined && Number.isFinite(dbhInches) && dbhInches > 0) {
    const dbhCm = dbhInches * 2.54;
    // Same saturating-exponential shape as estimateHeight: DBH drives size,
    // species mature spread caps implausible extrapolation.
    const diameter =
      1 + (matureDiameter - 1) * (1 - Math.exp(-dbhCm / (matureDiameter * 2.5)));
    return {
      diameterM: Math.min(
        MAX_VALID_CROWN_DIAMETER_M,
        Math.max(MIN_VALID_CROWN_DIAMETER_M, diameter)
      ),
      aspectRatio,
      method: species
        ? `DBH (${dbhInches.toFixed(1)} in) + species crown allometry`
        : `DBH (${dbhInches.toFixed(1)} in) generic crown allometry`,
    };
  }

  const matureFromSpecies = matureCrownDiameterForSpecies(species);
  if (matureFromSpecies) {
    // No DBH: scale the species' mature spread down using treeHeight (if
    // known) against a rough mature-height assumption, same 55% floor
    // treeHeight.ts uses when only species is known.
    const maturityFraction =
      typeof treeHeight === "number" && Number.isFinite(treeHeight) && treeHeight > 0
        ? Math.min(1, Math.max(0.55, treeHeight / 22))
        : 0.55;
    return {
      diameterM: Math.max(MIN_VALID_CROWN_DIAMETER_M, matureFromSpecies * maturityFraction),
      aspectRatio,
      method: "species typical-spread estimate (DBH unavailable)",
    };
  }

  return null;
}
