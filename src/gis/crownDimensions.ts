import { TreeCondition, VegetationPoint } from "../services/vegetation";
import { latLonToLocalMeters } from "../utils/geo";

// Derives the real, per-tree crown shape the renderer should draw, from the
// measurements each tree actually carries.
//
// Every tree reaches this point with a canopyPolygon (services/canopy.ts
// guarantees one — a LiDAR-segmented crown ring where available, otherwise a
// species/DBH-derived ellipse). The renderer previously reduced all of that
// to ONE number, `crownRadius`, and drew a circle: a real elm crown measured
// at 14m across one axis and 8m across the other rendered as a 11m circle,
// losing both its true width and its orientation. That flattening also
// costs accuracy in the GVI score, since a crown's apparent width from a
// given window depends on which way its long axis points.
//
// This module recovers the crown's principal axes from the polygon itself,
// so a measured crown is drawn at its measured proportions and bearing.

export interface CrownDimensions {
  /** Half-width along the crown's long axis, metres. */
  semiMajorM: number;
  /** Half-width across the long axis, metres. */
  semiMinorM: number;
  /**
   * Orientation of the long axis, radians counter-clockwise from local
   * east — matching the ENU frame (x = east) the crown geometry is built
   * in, so it feeds Matrix3.fromRotationZ directly.
   */
  headingRad: number;
  /**
   * How completely the crown fills the ellipse bounding its own principal
   * axes, 0..1. A solid, dense canopy approaches ~1; a sparse or forked one
   * that the LiDAR segmented into a ragged outline sits lower. Used to vary
   * canopy fullness so dense and thin trees don't render identically.
   */
  fillRatio: number;
  /** True when these came from a measured crown ring rather than a fallback. */
  measured: boolean;
}

/**
 * Real crowns are rarely more than about twice as long as they are wide.
 * A ratio beyond this usually means the LiDAR watershed segmentation merged
 * two neighbouring trees into one sliver-shaped blob, and rendering that
 * literally produces a long thin smear that looks nothing like a tree —
 * so the shape is pulled back toward circular instead.
 */
const MAX_AXIS_RATIO = 2.2;

/** Below this many vertices a ring can't describe a shape worth measuring. */
const MIN_RING_VERTICES = 4;

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Canopy fullness implied by a field-assessed condition rating. A tree in
 * poor condition has genuinely thinner, patchier foliage than a thriving
 * one, and this is the only real density signal available for trees without
 * a LiDAR-measured crown outline.
 *
 * Trees with no rating sit just under Good rather than at it — asserting
 * perfect density for a tree nobody assessed would overstate it.
 */
function conditionFillRatio(condition: TreeCondition | undefined): number {
  switch (condition) {
    case "Good":
      return 1;
    case "Fair":
      return 0.78;
    case "Poor":
      return 0.55;
    default:
      return 0.9;
  }
}

/**
 * A stable pseudo-random bearing derived from the tree's own id — the same
 * approach treeSpecies.ts already uses for per-tree variation. Deterministic,
 * so a tree does not change orientation between renders.
 */
function estimatedHeadingRad(treeId: string): number {
  let hash = 0;
  for (let i = 0; i < treeId.length; i++) {
    hash = (hash * 31 + treeId.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) % 3600) / 3600 * Math.PI;
}

/** Shoelace area, in the local metre plane. */
function ringAreaM2(points: { east: number; north: number }[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.east * b.north - b.east * a.north;
  }
  return Math.abs(sum) / 2;
}

/**
 * Principal axes of a ring, via the eigenvectors of its 2x2 covariance
 * matrix — the standard closed-form solution, so no iterative solver is
 * needed for what is only ever a handful of vertices.
 */
function principalAxes(points: { east: number; north: number }[]): {
  semiMajorM: number;
  semiMinorM: number;
  headingRad: number;
} | null {
  const n = points.length;
  const meanEast = points.reduce((sum, p) => sum + p.east, 0) / n;
  const meanNorth = points.reduce((sum, p) => sum + p.north, 0) / n;

  let cee = 0;
  let cnn = 0;
  let cen = 0;
  for (const p of points) {
    const de = p.east - meanEast;
    const dn = p.north - meanNorth;
    cee += de * de;
    cnn += dn * dn;
    cen += de * dn;
  }
  cee /= n;
  cnn /= n;
  cen /= n;

  // Eigenvalues of [[cee, cen], [cen, cnn]].
  const trace = cee + cnn;
  const diff = Math.sqrt((cee - cnn) * (cee - cnn) + 4 * cen * cen);
  const majorVariance = (trace + diff) / 2;
  const minorVariance = (trace - diff) / 2;
  if (!Number.isFinite(majorVariance) || majorVariance <= 0) return null;

  // For a ring sampled evenly around an ellipse's rim, the variance along
  // an axis is exactly half that axis' semi-length squared (mean of
  // A^2*cos^2 over a full turn is A^2/2) — so the semi-length is the
  // standard deviation times sqrt(2). Verified numerically against a
  // synthetic 7m x 3m ellipse, which round-trips to 7.00 x 3.00.
  const semiMajorM = Math.sqrt(majorVariance) * Math.SQRT2;
  const semiMinorM = Math.sqrt(Math.max(minorVariance, 0)) * Math.SQRT2;

  // Angle of the major eigenvector, counter-clockwise from the local EAST
  // axis. That is deliberately the same convention as the ENU frame the
  // geometry is built in (x = east) and as Matrix3.fromRotationZ, so this
  // value can be handed straight to the renderer without conversion.
  const headingRad = Math.atan2(2 * cen, cee - cnn) / 2;

  return { semiMajorM, semiMinorM, headingRad };
}

/**
 * Resolves the crown shape to draw for one tree.
 *
 * Priority mirrors services/canopy.ts's own data-quality chain: a measured
 * crown ring is used at its real proportions; otherwise the tree falls back
 * to the circular crownRadius that canopy.ts already resolved (itself
 * species/DBH-derived), and finally to a height proportion.
 */
export function resolveCrownDimensions(
  tree: VegetationPoint,
  /** The circular radius the caller already resolved — used when no measured ring is available. */
  fallbackRadiusM: number
): CrownDimensions {
  const fallbackRadius = isPositiveFinite(fallbackRadiusM) ? fallbackRadiusM : 1;

  const ring = tree.canopyPolygon;
  const usableRing =
    Array.isArray(ring) && ring.length >= MIN_RING_VERTICES ? ring : null;

  // A LiDAR/API ring is a genuine measurement of one specific crown, so its
  // orientation is real and is used as-is.
  const isMeasuredRing =
    usableRing !== null &&
    (tree.canopySource === "lidar_polygon" || tree.canopySource === "api_polygon");

  // A species_ellipse ring is NOT a measurement of this crown's outline, but
  // it is still built from real per-tree data: canopy.ts sizes it from the
  // inventory's measured DBH via species allometry, and gives it that
  // species' typical width:depth ratio. Reading its axes back is therefore
  // worth doing — that is where nearly every tree's real size variation
  // lives, since LiDAR is not configured in most deployments. Excluding it
  // (as this originally did) left every such tree a plain circle and made
  // the whole crown-shape pipeline inert.
  const isEstimatedRing = usableRing !== null && tree.canopySource === "species_ellipse";

  if (!isMeasuredRing && !isEstimatedRing) {
    return {
      semiMajorM: Math.max(0.6, fallbackRadius),
      semiMinorM: Math.max(0.6, fallbackRadius),
      headingRad: estimatedHeadingRad(tree.id),
      fillRatio: conditionFillRatio(tree.condition),
      measured: false,
    };
  }

  const local = usableRing.map((point) => {
    const { eastM, northM } = latLonToLocalMeters(
      tree.latitude,
      tree.longitude,
      point.latitude,
      point.longitude
    );
    return { east: eastM, north: northM };
  });

  const axes = principalAxes(local);
  if (!axes || axes.semiMajorM <= 0) {
    return {
      semiMajorM: Math.max(0.6, fallbackRadius),
      semiMinorM: Math.max(0.6, fallbackRadius),
      headingRad: estimatedHeadingRad(tree.id),
      fillRatio: conditionFillRatio(tree.condition),
      measured: false,
    };
  }

  // Clamp merged-blob slivers back toward circular (see MAX_AXIS_RATIO).
  let { semiMajorM, semiMinorM } = axes;
  if (semiMinorM <= 0 || semiMajorM / semiMinorM > MAX_AXIS_RATIO) {
    semiMinorM = semiMajorM / MAX_AXIS_RATIO;
  }

  // Density. For a real measured crown this is the honest geometric answer:
  // how much of its own fitted ellipse the outline actually fills, so a
  // ragged or forked crown reads as thinner than a solid one. A synthesised
  // species ellipse always fills itself perfectly, so measuring it would
  // just return 1 for every tree — those fall back to the inventory's
  // assessed condition, which is the real density signal available.
  const ellipseAreaM2 = Math.PI * semiMajorM * semiMinorM;
  const fillRatio = isMeasuredRing
    ? ellipseAreaM2 > 0
      ? Math.min(1, Math.max(0.35, ringAreaM2(local) / ellipseAreaM2))
      : 1
    : conditionFillRatio(tree.condition);

  return {
    semiMajorM: Math.max(0.6, semiMajorM),
    semiMinorM: Math.max(0.6, semiMinorM),
    // A species ellipse is generated axis-aligned, so every one of them
    // would otherwise point due east and the whole street would render as
    // identically-oriented ovals. A stable per-tree angle keeps the real
    // species proportions while looking like a street of individual trees.
    headingRad: isMeasuredRing ? axes.headingRad : estimatedHeadingRad(tree.id),
    fillRatio,
    measured: isMeasuredRing,
  };
}
