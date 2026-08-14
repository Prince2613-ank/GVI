import * as Cesium from "cesium";
import { TreeCondition } from "../services/vegetation";

// Procedural species variety for TreeRenderer, built entirely from Cesium's
// existing geometry primitives (ellipsoids/cylinders) — no bark/leaf texture
// assets or glTF tree models exist in this repo, so this stops short of true
// PBR materials or per-leaf geometry. What it does give: a real canopy-shape
// silhouette and trunk/leaf color per species instead of every tree being an
// identical green sphere on a brown cylinder.

export type CanopyShape =
  | "round"
  | "oval"
  | "cone"
  | "column"
  | "umbrella"
  | "multiLayer"
  | "irregular";

export interface TreeSpeciesProfile {
  name: string;
  canopyShape: CanopyShape;
  /** HSL, hue/saturation/lightness in [0,1] — jittered per-tree in TreeRenderer. */
  canopyHsl: [number, number, number];
  trunkColor: Cesium.Color;
  /** Canopy width as a multiple of height (species silhouette proportions). */
  widthToHeightRatio: number;
}

const PALM: TreeSpeciesProfile = {
  name: "Palm",
  canopyShape: "umbrella",
  canopyHsl: [0.28, 0.55, 0.38],
  trunkColor: Cesium.Color.fromCssColorString("#8a7a5c"),
  widthToHeightRatio: 0.55,
};

const PINE: TreeSpeciesProfile = {
  name: "Pine",
  canopyShape: "cone",
  canopyHsl: [0.35, 0.45, 0.22],
  trunkColor: Cesium.Color.fromCssColorString("#6b4226"),
  widthToHeightRatio: 0.4,
};

const BANYAN: TreeSpeciesProfile = {
  name: "Banyan",
  canopyShape: "multiLayer",
  canopyHsl: [0.32, 0.4, 0.28],
  trunkColor: Cesium.Color.fromCssColorString("#5c5248"),
  widthToHeightRatio: 0.95,
};

const PEEPAL: TreeSpeciesProfile = {
  name: "Peepal",
  canopyShape: "multiLayer",
  canopyHsl: [0.3, 0.45, 0.32],
  trunkColor: Cesium.Color.fromCssColorString("#6e5a45"),
  widthToHeightRatio: 0.85,
};

const OAK: TreeSpeciesProfile = {
  name: "Oak",
  canopyShape: "round",
  canopyHsl: [0.31, 0.42, 0.27],
  trunkColor: Cesium.Color.fromCssColorString("#5a4632"),
  widthToHeightRatio: 0.75,
};

const MAPLE: TreeSpeciesProfile = {
  name: "Maple",
  canopyShape: "oval",
  canopyHsl: [0.34, 0.5, 0.3],
  trunkColor: Cesium.Color.fromCssColorString("#4f3b2a"),
  widthToHeightRatio: 0.65,
};

const NEEM: TreeSpeciesProfile = {
  name: "Neem",
  canopyShape: "irregular",
  canopyHsl: [0.29, 0.48, 0.3],
  trunkColor: Cesium.Color.fromCssColorString("#6b5a44"),
  widthToHeightRatio: 0.7,
};

const ASHOKA: TreeSpeciesProfile = {
  name: "Ashoka",
  canopyShape: "column",
  canopyHsl: [0.33, 0.5, 0.24],
  trunkColor: Cesium.Color.fromCssColorString("#5a4a3a"),
  widthToHeightRatio: 0.3,
};

/** Generic deciduous fallback for street trees with no species match. */
const GENERIC: TreeSpeciesProfile = {
  name: "Deciduous",
  canopyShape: "round",
  canopyHsl: [0.32, 0.42, 0.3],
  trunkColor: Cesium.Color.fromCssColorString("#654321"),
  widthToHeightRatio: 0.65,
};

const SPECIES_PROFILES: Array<[RegExp, TreeSpeciesProfile]> = [
  [/palm/i, PALM],
  [/pine|spruce|fir|conifer/i, PINE],
  [/banyan/i, BANYAN],
  [/peepal|ficus religiosa|bodhi/i, PEEPAL],
  [/\boak\b/i, OAK],
  [/maple/i, MAPLE],
  [/neem/i, NEEM],
  [/ashoka/i, ASHOKA],
  // Species from SPECIES_MATURE_HEIGHT_M (treeHeight.ts) not given their own
  // silhouette above still get a reasonable shape via these broader matches
  // rather than falling all the way through to GENERIC.
  [/london planetree|sycamore|elm|linden|basswood|ash|sweetgum/i, OAK],
  [/honeylocust|honey locust|ginkgo|zelkova|cherry|callery pear|\bpear\b|crab ?apple|redbud/i, MAPLE],
];

export function resolveSpeciesProfile(
  species?: string | null,
  label?: string | null
): TreeSpeciesProfile {
  const key = species ?? label;
  if (!key) return GENERIC;
  return SPECIES_PROFILES.find(([pattern]) => pattern.test(key))?.[1] ?? GENERIC;
}

// Deterministic per-tree pseudo-random in [0, 1), seeded from the tree's own
// id — same tree always jitters the same way (stable across re-renders),
// but different trees of the same species don't all look identical.
function seededUnit(seed: string, salt: number): number {
  let hash = salt;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  // Fold the 32-bit hash into [0, 1).
  return ((hash >>> 0) % 100000) / 100000;
}

/**
 * Jitters a species' base canopy color per-tree so a whole street of the
 * same species doesn't render as identical flat green blocks: hue ±8%,
 * saturation ±5%, lightness ("brightness") ±10%, all deterministic per
 * tree id.
 */
export function jitteredCanopyColor(profile: TreeSpeciesProfile, treeId: string): Cesium.Color {
  const [h, s, l] = profile.canopyHsl;
  const hueJitter = (seededUnit(treeId, 1) * 2 - 1) * 0.08;
  const satJitter = (seededUnit(treeId, 2) * 2 - 1) * 0.05;
  const lightJitter = (seededUnit(treeId, 3) * 2 - 1) * 0.1;
  const hue = (h + hueJitter + 1) % 1;
  const saturation = Math.min(1, Math.max(0, s + satJitter));
  const lightness = Math.min(1, Math.max(0, l + lightJitter));
  return Cesium.Color.fromHsl(hue, saturation, lightness, 0.85);
}

/** Same seeded-jitter approach, used for small canopy-cluster position offsets (irregular/multiLayer shapes). */
export function seededJitter(treeId: string, salt: number, magnitude: number): number {
  return (seededUnit(treeId, salt) * 2 - 1) * magnitude;
}

/** Deterministic per-tree value in [0,1) — for procedural variation that isn't a ± jitter (e.g. maturity, health). */
export function seededFraction(treeId: string, salt: number): number {
  return seededUnit(treeId, salt);
}

/**
 * Per-tree structural imperfections — small deterministic randomness so no
 * two trees of the same species are geometrically identical. All bounded to
 * subtle amounts; this is meant to read as "natural variation," not visibly
 * broken/leaning trees.
 */
export interface TreeImperfections {
  /** Trunk+crown tilt off vertical, radians (~0-6°). */
  leanAngleRad: number;
  /** Direction the tree leans, radians. */
  leanHeadingRad: number;
  /** Multiplier on the trunk's taper ratio (~0.85-1.15 — some trunks taper more sharply than others). */
  trunkTaperJitter: number;
  /** 0 (young/sparse) .. 1 (old/full) — scales canopy fullness and trunk girth. */
  maturity: number;
  /** 0 (healthy, full saturation/green) .. 1 (stressed — desaturated, yellow-brown tint). */
  stress: number;
}

/**
 * Stress implied by a real, in-person arborist assessment. A small
 * per-tree jitter is kept on top so a whole street of "Fair" trees still
 * varies visibly rather than rendering as one flat colour.
 */
function stressFromCondition(condition: TreeCondition, treeId: string): number {
  const base = { Good: 0.05, Fair: 0.35, Poor: 0.7 }[condition];
  return Math.min(1, Math.max(0, base + (seededFraction(treeId, 44) - 0.5) * 0.16));
}

/**
 * `condition` is the tree's field-assessed rating where the inventory
 * supplies one. Passing it is what makes canopy colour reflect real
 * observed health; without it the stress value is a deterministic
 * pseudo-random stand-in, which looks varied but means nothing.
 */
export function resolveImperfections(
  treeId: string,
  condition?: TreeCondition
): TreeImperfections {
  return {
    leanAngleRad: seededFraction(treeId, 40) * Cesium.Math.toRadians(6),
    leanHeadingRad: seededFraction(treeId, 41) * Math.PI * 2,
    trunkTaperJitter: 0.85 + seededFraction(treeId, 42) * 0.3,
    maturity: seededFraction(treeId, 43),
    stress: condition
      ? stressFromCondition(condition, treeId)
      : // No assessment for this tree — skewed toward 0 (healthy), since
        // most street trees are fine and claiming otherwise would be worse
        // than admitting we don't know.
        Math.max(0, seededFraction(treeId, 44) * 1.6 - 0.6),
  };
}

/**
 * Blends a "dry/stressed" tint (desaturated, shifted toward yellow-brown)
 * into the base canopy color, proportional to this tree's stress value —
 * every tree still gets its normal per-tree hue/saturation/lightness
 * jitter first (jitteredCanopyColor), this layers health on top of that
 * result.
 */
export function applyHealthTint(color: Cesium.Color, stress: number): Cesium.Color {
  if (stress <= 0) return color;
  const dryColor = Cesium.Color.fromCssColorString("#a68a4a");
  return Cesium.Color.lerp(color, dryColor, Math.min(1, stress) * 0.7, new Cesium.Color());
}
