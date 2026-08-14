import * as Cesium from "cesium";
import { VegetationPoint } from "../services/vegetation";
import {
  applyHealthTint,
  CanopyShape,
  jitteredCanopyColor,
  resolveImperfections,
  resolveSpeciesProfile,
  seededJitter,
  TreeImperfections,
  TreeSpeciesProfile,
} from "./treeSpecies";
import { resolveCrownDimensions } from "./crownDimensions";

export type Tessellation = "fine" | "medium" | "coarse";

const INCHES_TO_METERS = 0.0254;
/** Trunks flare below breast height, where DBH is measured — the base is modestly wider. */
const TRUNK_BASE_FLARE = 1.25;
/**
 * Guards against inventory rows carrying 0, a placeholder, or an implausible
 * diameter (the widest street trees top out well under 2m across); anything
 * outside this range falls back to the crown-proportional estimate.
 */
export function isMeasuredDbhInches(dbhInches: number | undefined): dbhInches is number {
  return (
    typeof dbhInches === "number" &&
    Number.isFinite(dbhInches) &&
    dbhInches >= 1 &&
    dbhInches <= 80
  );
}

interface CrownGeometryOptions {
  tree: VegetationPoint;
  groundHeight: number;
  treeHeight: number;
  /** Overall canopy width (already resolved from API canopyDiameter/2, or a species-proportioned fallback). */
  canopyRadius: number;
  tessellation: Tessellation;
  /** [near, far] meters — Cesium hides this instance outside the range automatically, every frame, with no extra per-frame code needed here. */
  distanceDisplayConditionM?: [number, number];
}

// `fine` previously passed {} — which does NOT mean "a sensible default",
// it means Cesium's EllipsoidGeometry default of 64x64 partitions: roughly
// 8,000 triangles per lobe, and crowns are built from up to 3 lobes, so a
// single near tree cost ~25,000 triangles. That was also a ~21x jump in
// triangle count across the LOD0/LOD1 boundary sitting right next to it at
// 150m, which is far more detail than a rounded canopy can show at that
// distance. 32x20 keeps the silhouette smooth while cutting LOD0 geometry
// about 4x — and with it the worker tessellation time that "Analyse GVI"
// waits on.
const ELLIPSOID_TESSELLATION: Record<Tessellation, { slicePartitions?: number; stackPartitions?: number }> = {
  fine: { slicePartitions: 32, stackPartitions: 20 },
  medium: { slicePartitions: 24, stackPartitions: 16 },
  coarse: { slicePartitions: 8, stackPartitions: 6 },
};
const CYLINDER_SLICES: Record<Tessellation, number> = {
  fine: 16,
  medium: 12,
  coarse: 8,
};

function distanceDisplayConditionAttribute(
  range?: [number, number]
): Cesium.DistanceDisplayConditionGeometryInstanceAttribute | undefined {
  if (!range) return undefined;
  return new Cesium.DistanceDisplayConditionGeometryInstanceAttribute(range[0], range[1]);
}

/**
 * A tree "leaning" is a horizontal displacement that grows with height
 * above the ground (a real leaning trunk sweeps sideways more the higher
 * up you look), computed here as a local east/north offset applied through
 * the tree's own east-north-up frame — the same technique already used for
 * the irregular canopy's lobe offsets below, just generalized to any
 * height. This reads as a natural tilt without needing an actual rotation
 * matrix composed into modelMatrix.
 */
function leanedPosition(
  longitude: number,
  latitude: number,
  groundHeight: number,
  heightAboveGround: number,
  imperfections: TreeImperfections
): Cesium.Cartesian3 {
  const base = Cesium.Cartesian3.fromDegrees(longitude, latitude, groundHeight);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(base);
  const leanOffset = heightAboveGround * Math.tan(imperfections.leanAngleRad);
  const east = Math.cos(imperfections.leanHeadingRad) * leanOffset;
  const north = Math.sin(imperfections.leanHeadingRad) * leanOffset;
  return Cesium.Matrix4.multiplyByPoint(
    enu,
    new Cesium.Cartesian3(east, north, heightAboveGround),
    new Cesium.Cartesian3()
  );
}

/**
 * `headingRad` rotates the ellipsoid about its own vertical axis, so a
 * crown measured as elongated can be drawn pointing the way it actually
 * points. Composed onto the east-north-up frame rather than replacing it,
 * so the crown still sits level on the local horizon.
 */
function ellipsoidInstance(
  id: string,
  center: Cesium.Cartesian3,
  radii: Cesium.Cartesian3,
  color: Cesium.Color,
  tessellation: Tessellation,
  distanceDisplayConditionM?: [number, number],
  headingRad = 0
): Cesium.GeometryInstance {
  const distanceDisplayCondition = distanceDisplayConditionAttribute(distanceDisplayConditionM);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
  const modelMatrix =
    headingRad === 0
      ? enu
      : Cesium.Matrix4.multiplyByMatrix3(
          enu,
          Cesium.Matrix3.fromRotationZ(headingRad, new Cesium.Matrix3()),
          new Cesium.Matrix4()
        );
  return new Cesium.GeometryInstance({
    id,
    geometry: new Cesium.EllipsoidGeometry({
      radii,
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      ...ELLIPSOID_TESSELLATION[tessellation],
    }),
    modelMatrix,
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
      ...(distanceDisplayCondition ? { distanceDisplayCondition } : {}),
    },
  });
}

function coneInstance(
  id: string,
  center: Cesium.Cartesian3,
  length: number,
  bottomRadius: number,
  color: Cesium.Color,
  tessellation: Tessellation,
  distanceDisplayConditionM?: [number, number]
): Cesium.GeometryInstance {
  const distanceDisplayCondition = distanceDisplayConditionAttribute(distanceDisplayConditionM);
  return new Cesium.GeometryInstance({
    id,
    geometry: new Cesium.CylinderGeometry({
      length,
      topRadius: Math.max(0.05, bottomRadius * 0.03),
      bottomRadius,
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      slices: CYLINDER_SLICES[tessellation],
    }),
    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(center),
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
      ...(distanceDisplayCondition ? { distanceDisplayCondition } : {}),
    },
  });
}

/**
 * Builds this tree's canopy as 1-3 geometry instances depending on its
 * species' silhouette shape — round/oval/column/umbrella are a single
 * ellipsoid at different proportions, cone is an actual tapered cylinder
 * (conifers), multiLayer/irregular stack or offset several smaller
 * ellipsoids for banyan/peepal-style spreading canopies or a looser organic
 * silhouette instead of one perfect sphere.
 */
export function buildCrownInstances(options: CrownGeometryOptions): Cesium.GeometryInstance[] {
  const { tree, groundHeight, treeHeight, canopyRadius, tessellation, distanceDisplayConditionM } = options;
  const profile = resolveSpeciesProfile(tree.species, tree.label);
  const imperfections = resolveImperfections(tree.id, tree.condition);
  const baseColor = applyHealthTint(jitteredCanopyColor(profile, tree.id), imperfections.stress);

  // The crown's REAL proportions and bearing where they were measured (see
  // crownDimensions.ts); a circle of the resolved radius otherwise. `radius`
  // is kept as the mean of the two axes so every shape's existing
  // proportional arithmetic — which was written against one radius and is
  // carefully tuned so each canopy top lands exactly on treeHeight — keeps
  // working unchanged; the two axes are then applied as a scale around it.
  const crown = resolveCrownDimensions(tree, canopyRadius);
  const radius = Math.max(0.6, (crown.semiMajorM + crown.semiMinorM) / 2);
  const majorScale = crown.semiMajorM / radius;
  const minorScale = crown.semiMinorM / radius;
  const crownHeading = crown.headingRad;
  // A sparse crown is drawn slightly slimmer than its outline suggests, a
  // dense one at full width — so "how solid is this tree" is visible rather
  // than every canopy reading as equally packed. Bounded so even the
  // thinnest measured crown keeps a believable body.
  const densityScale = 0.82 + crown.fillRatio * 0.18;

  /** Horizontal radii for a crown element, honouring measured elongation and density. */
  const horizontal = (factor: number): { major: number; minor: number } => ({
    major: radius * factor * majorScale * densityScale,
    minor: radius * factor * minorScale * densityScale,
  });

  // Per-lobe color variation (multiLayer/irregular only) is computed inline
  // at each lobe below — small extra lightness jitter on top of the tree's
  // own base color, so a single canopy reads as having subtle internal
  // color variation ("subtle color gradients") using only the standard
  // flat per-instance color mechanism, no per-vertex gradient shader needed.

  const at = (heightFraction: number): Cesium.Cartesian3 =>
    leanedPosition(tree.longitude, tree.latitude, groundHeight, treeHeight * heightFraction, imperfections);

  switch (profile.canopyShape as CanopyShape) {
    // Every shape below is chosen so its topmost point lands at EXACTLY
    // treeHeight above ground (center fraction + vertical-radius fraction
    // == 1.0) — this used to drift by several percent per shape (cone
    // undershot by ~7%, column/oval overshot by ~4-8%), so the rendered
    // canopy top didn't match the tree's real, API-provided treeHeight
    // value. Confirmed by walking through each shape's arithmetic by hand.
    case "cone":
      return [
        coneInstance(
          `crown-${tree.id}`,
          at(0.62),
          Math.max(0.8, treeHeight * 0.76), // half-length fraction 0.38; 0.62 + 0.38 = 1.0
          // A cone is a cylinder geometry with a single bottomRadius, so it
          // can't take two axes; the mean measured radius is the honest
          // single-number answer for a conifer's spread.
          radius * densityScale,
          baseColor,
          tessellation,
          distanceDisplayConditionM
        ),
      ];

    case "column":
      return [
        ellipsoidInstance(
          `crown-${tree.id}`,
          at(0.68),
          new Cesium.Cartesian3(horizontal(0.55).major, horizontal(0.55).minor, Math.max(0.6, treeHeight * 0.32)), // 0.68 + 0.32 = 1.0
          baseColor,
          tessellation,
          distanceDisplayConditionM,
          crownHeading
        ),
      ];

    case "umbrella":
      return [
        ellipsoidInstance(
          `crown-${tree.id}`,
          at(0.9),
          new Cesium.Cartesian3(horizontal(1.15).major, horizontal(1.15).minor, Math.max(0.5, treeHeight * 0.1)), // 0.9 + 0.1 = 1.0
          baseColor,
          tessellation,
          distanceDisplayConditionM,
          crownHeading
        ),
      ];

    case "oval":
      return [
        ellipsoidInstance(
          `crown-${tree.id}`,
          at(0.68),
          new Cesium.Cartesian3(horizontal(0.82).major, horizontal(0.82).minor, Math.max(0.6, treeHeight * 0.32)), // 0.68 + 0.32 = 1.0
          baseColor,
          tessellation,
          distanceDisplayConditionM,
          crownHeading
        ),
      ];

    case "multiLayer": {
      // Only the TOP layer's fraction needs to land exactly on 1.0 (that's
      // the tree's actual highest point) — the lower two are interior
      // layers, their exact height doesn't define "how tall the tree is".
      const layers = [
        { heightFraction: 0.45, radiusFactor: 1.0, zFraction: 0.16 },
        { heightFraction: 0.65, radiusFactor: 0.78, zFraction: 0.16 },
        { heightFraction: 0.85, radiusFactor: 0.5, zFraction: 0.15 }, // 0.85 + 0.15 = 1.0
      ];
      return layers.map(({ heightFraction, radiusFactor, zFraction }, index) => {
        const jitteredLightness = Math.min(
          1,
          Math.max(0, profile.canopyHsl[2] + seededJitter(tree.id, 50 + index, 0.06))
        );
        const layerColor = applyHealthTint(
          Cesium.Color.fromHsl(profile.canopyHsl[0], profile.canopyHsl[1], jitteredLightness, 0.85),
          imperfections.stress
        );
        return ellipsoidInstance(
          `crown-${tree.id}-${index}`,
          at(heightFraction),
          new Cesium.Cartesian3(
            horizontal(radiusFactor).major,
            horizontal(radiusFactor).minor,
            Math.max(0.5, treeHeight * zFraction)
          ),
          layerColor,
          tessellation,
          distanceDisplayConditionM,
          crownHeading
        );
      });
    }

    case "irregular": {
      // 3 smaller lobes offset around the main center by a small,
      // deterministic-per-tree amount — breaks the perfect-sphere look
      // without needing real leaf-cluster geometry. Baseline height
      // fraction 0.78 + the fixed 0.22 z-fraction below = 1.0 exactly at
      // zero jitter; the ±0.12 jitter then lets individual lobes sit a bit
      // above or below the tree's nominal top, which is the correct look
      // for an "irregular" organic canopy (real ones aren't flat-topped),
      // rather than being systematically short the way the old 0.62
      // baseline was (0.62 + 0.22 = 0.84, ~16% under treeHeight even
      // un-jittered).
      const lobes = [0, 1, 2].map((lobeIndex) => {
        const angle = seededJitter(tree.id, 10 + lobeIndex, Math.PI) + (lobeIndex * (Math.PI * 2)) / 3;
        // Lobes are spread around the crown's own measured ellipse, not a
        // circle — otherwise an elongated crown would render as elongated
        // lobes bunched into a round cluster, cancelling out the elongation
        // the measurement established.
        const offsetRadius = radius * 0.35 * densityScale;
        const localEast = Math.cos(angle) * offsetRadius * majorScale;
        const localNorth = Math.sin(angle) * offsetRadius * minorScale;
        const cosHeading = Math.cos(crownHeading);
        const sinHeading = Math.sin(crownHeading);
        const eastOffset = localEast * cosHeading - localNorth * sinHeading;
        const northOffset = localEast * sinHeading + localNorth * cosHeading;
        const heightFraction = 0.78 + seededJitter(tree.id, 20 + lobeIndex, 0.12);
        const lobeRadius = radius * (0.55 + seededJitter(tree.id, 30 + lobeIndex, 0.15));
        const origin = at(heightFraction);
        const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
        const center = Cesium.Matrix4.multiplyByPoint(
          enu,
          new Cesium.Cartesian3(eastOffset, northOffset, 0),
          new Cesium.Cartesian3()
        );
        const jitteredLightness = Math.min(
          1,
          Math.max(0, profile.canopyHsl[2] + seededJitter(tree.id, 50 + lobeIndex, 0.06))
        );
        const lobeColorValue = applyHealthTint(
          Cesium.Color.fromHsl(profile.canopyHsl[0], profile.canopyHsl[1], jitteredLightness, 0.85),
          imperfections.stress
        );
        return ellipsoidInstance(
          `crown-${tree.id}-${lobeIndex}`,
          center,
          new Cesium.Cartesian3(
            lobeRadius * majorScale * densityScale,
            lobeRadius * minorScale * densityScale,
            Math.max(0.5, treeHeight * 0.22)
          ),
          lobeColorValue,
          tessellation,
          distanceDisplayConditionM,
          crownHeading
        );
      });
      return lobes;
    }

    case "round":
    default:
      return [
        ellipsoidInstance(
          `crown-${tree.id}`,
          at(0.72),
          new Cesium.Cartesian3(horizontal(1).major, horizontal(1).minor, Math.max(0.6, treeHeight * 0.28)),
          baseColor,
          tessellation,
          distanceDisplayConditionM,
          crownHeading
        ),
      ];
  }
}

/** Species-appropriate trunk: umbrella/column species (palms, ashoka) have a longer bare trunk before the canopy starts; cone/round species have a shorter one. */
export function trunkLengthFraction(profile: TreeSpeciesProfile): number {
  switch (profile.canopyShape) {
    case "umbrella":
      return 0.85;
    case "column":
      return 0.65;
    case "cone":
      return 0.35;
    default:
      return 0.55;
  }
}

export function buildTrunkInstance(
  tree: VegetationPoint,
  groundHeight: number,
  treeHeight: number,
  canopyRadius: number,
  tessellation: Tessellation = "fine",
  distanceDisplayConditionM?: [number, number]
): Cesium.GeometryInstance {
  const profile = resolveSpeciesProfile(tree.species, tree.label);
  const imperfections = resolveImperfections(tree.id, tree.condition);
  const radius = Math.max(0.6, canopyRadius);
  const trunkLength = Math.max(1, treeHeight * trunkLengthFraction(profile));
  // Taper ratio and overall girth both get per-tree jitter (trunkTaperJitter,
  // maturity) so trunks of the same species aren't identical cylinders.
  const girth = 0.8 + imperfections.maturity * 0.4;

  // Trunk width comes from the tree's REAL measured diameter at breast
  // height where the inventory supplies one (NYC Forestry records DBH in
  // inches for most of its trees), rather than being inferred from crown
  // width. Those two genuinely diverge: a heavily pruned street tree can
  // carry a thick trunk under a small crown, and a young open-grown tree
  // the reverse. Falls back to the previous crown-proportional estimate
  // when no DBH was recorded.
  const dbhRadiusM = isMeasuredDbhInches(tree.dbhInches)
    ? (tree.dbhInches * INCHES_TO_METERS) / 2
    : null;
  // DBH is measured at ~1.3m up, so the base flares somewhat wider than it.
  const bottomRadius = dbhRadiusM !== null
    ? Math.max(0.16, dbhRadiusM * TRUNK_BASE_FLARE)
    : Math.max(0.16, radius * 0.11 * girth);
  const topRadius = dbhRadiusM !== null
    ? Math.max(0.06, dbhRadiusM * (0.55 + 0.2 * (2 - imperfections.trunkTaperJitter)))
    : Math.max(0.06, radius * 0.045 * girth * (2 - imperfections.trunkTaperJitter));

  const distanceDisplayCondition = distanceDisplayConditionAttribute(distanceDisplayConditionM);
  return new Cesium.GeometryInstance({
    id: `trunk-${tree.id}`,
    geometry: new Cesium.CylinderGeometry({
      length: trunkLength,
      topRadius,
      bottomRadius,
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      slices: CYLINDER_SLICES[tessellation],
    }),
    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
      leanedPosition(tree.longitude, tree.latitude, groundHeight, trunkLength / 2, imperfections)
    ),
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(profile.trunkColor),
      ...(distanceDisplayCondition ? { distanceDisplayCondition } : {}),
    },
  });
}
