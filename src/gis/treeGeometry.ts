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

export type Tessellation = "fine" | "medium" | "coarse";

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

const ELLIPSOID_TESSELLATION: Record<Tessellation, { slicePartitions?: number; stackPartitions?: number }> = {
  fine: {},
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

function ellipsoidInstance(
  id: string,
  center: Cesium.Cartesian3,
  radii: Cesium.Cartesian3,
  color: Cesium.Color,
  tessellation: Tessellation,
  distanceDisplayConditionM?: [number, number]
): Cesium.GeometryInstance {
  const distanceDisplayCondition = distanceDisplayConditionAttribute(distanceDisplayConditionM);
  return new Cesium.GeometryInstance({
    id,
    geometry: new Cesium.EllipsoidGeometry({
      radii,
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      ...ELLIPSOID_TESSELLATION[tessellation],
    }),
    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(center),
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
  const imperfections = resolveImperfections(tree.id);
  const baseColor = applyHealthTint(jitteredCanopyColor(profile, tree.id), imperfections.stress);
  const radius = Math.max(0.6, canopyRadius);

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
          radius,
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
          new Cesium.Cartesian3(radius * 0.55, radius * 0.55, Math.max(0.6, treeHeight * 0.32)), // 0.68 + 0.32 = 1.0
          baseColor,
          tessellation,
          distanceDisplayConditionM
        ),
      ];

    case "umbrella":
      return [
        ellipsoidInstance(
          `crown-${tree.id}`,
          at(0.9),
          new Cesium.Cartesian3(radius * 1.15, radius * 1.15, Math.max(0.5, treeHeight * 0.1)), // 0.9 + 0.1 = 1.0
          baseColor,
          tessellation,
          distanceDisplayConditionM
        ),
      ];

    case "oval":
      return [
        ellipsoidInstance(
          `crown-${tree.id}`,
          at(0.68),
          new Cesium.Cartesian3(radius * 0.82, radius * 0.82, Math.max(0.6, treeHeight * 0.32)), // 0.68 + 0.32 = 1.0
          baseColor,
          tessellation,
          distanceDisplayConditionM
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
            radius * radiusFactor,
            radius * radiusFactor,
            Math.max(0.5, treeHeight * zFraction)
          ),
          layerColor,
          tessellation,
          distanceDisplayConditionM
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
        const offsetRadius = radius * 0.35;
        const eastOffset = Math.cos(angle) * offsetRadius;
        const northOffset = Math.sin(angle) * offsetRadius;
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
          new Cesium.Cartesian3(lobeRadius, lobeRadius, Math.max(0.5, treeHeight * 0.22)),
          lobeColorValue,
          tessellation,
          distanceDisplayConditionM
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
          new Cesium.Cartesian3(radius, radius, Math.max(0.6, treeHeight * 0.28)),
          baseColor,
          tessellation,
          distanceDisplayConditionM
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
  const imperfections = resolveImperfections(tree.id);
  const radius = Math.max(0.6, canopyRadius);
  const trunkLength = Math.max(1, treeHeight * trunkLengthFraction(profile));
  // Taper ratio and overall girth both get per-tree jitter (trunkTaperJitter,
  // maturity) so trunks of the same species aren't identical cylinders.
  const girth = 0.8 + imperfections.maturity * 0.4;
  const distanceDisplayCondition = distanceDisplayConditionAttribute(distanceDisplayConditionM);
  return new Cesium.GeometryInstance({
    id: `trunk-${tree.id}`,
    geometry: new Cesium.CylinderGeometry({
      length: trunkLength,
      topRadius: Math.max(0.06, radius * 0.045 * girth * (2 - imperfections.trunkTaperJitter)),
      bottomRadius: Math.max(0.16, radius * 0.11 * girth),
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
