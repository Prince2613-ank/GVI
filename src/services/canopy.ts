// canopy.ts builds an actual canopy polygon for every tree, replacing the
// old single-fixed-radius approach. Priority chain (best data wins):
//   1. lidar_polygon    - real watershed-segmented crown from the LiDAR backend
//   2. api_polygon       - a canopy polygon supplied directly by a provider
//                          (forward-compatible slot; no current source hits this)
//   3. crown_radius_circle - a measured crownRadius with no ring (e.g. a
//                          LiDAR tree whose polygon was dropped/degenerate)
//   4. species_ellipse    - estimated from DBH/species via crownDiameter.ts
//   5. circle_fallback    - last resort, unknown species and no DBH
//
// Every tree gets canopyPolygon, crownRadius, canopyAreaM2, crownDiameterM,
// and canopySource populated, so downstream rendering and GVI code never
// need to special-case "this tree has no canopy data."

import { offsetLatLon, latLonToLocalMeters } from "../utils/geo";
import { estimateCrownDiameter, DEFAULT_CROWN_DIAMETER_M } from "./crownDiameter";
import {
  CanopyReport,
  CanopySource,
  VegetationFeature,
  VegetationPoint,
} from "./vegetation";

interface LatLon {
  latitude: number;
  longitude: number;
}

/**
 * Generates a geodesic ellipse ring around (centerLat, centerLon) using the
 * same flat-local-plane approximation offsetLatLon already uses elsewhere
 * (e.g. computeViewshedPolygon) — accurate enough at tree-crown scale
 * (a few meters), where the approximation error is negligible.
 */
export function generateEllipsePolygon(
  centerLat: number,
  centerLon: number,
  semiMajorM: number,
  semiMinorM: number,
  headingDeg = 0,
  numPoints = 16
): LatLon[] {
  const headingRad = (headingDeg * Math.PI) / 180;
  const majorDirEast = Math.sin(headingRad);
  const majorDirNorth = Math.cos(headingRad);
  const minorDirEast = Math.cos(headingRad);
  const minorDirNorth = -Math.sin(headingRad);

  const ring: LatLon[] = [];
  for (let i = 0; i < numPoints; i++) {
    const theta = (2 * Math.PI * i) / numPoints;
    const x = semiMajorM * Math.cos(theta);
    const y = semiMinorM * Math.sin(theta);
    const eastM = x * majorDirEast + y * minorDirEast;
    const northM = x * majorDirNorth + y * minorDirNorth;
    ring.push(offsetLatLon(centerLat, centerLon, eastM, northM));
  }
  return ring;
}

/** Shoelace polygon area in square meters, via local-meter projection. */
export function polygonAreaM2(polygon: LatLon[]): number {
  if (polygon.length < 3) return 0;
  const originLat = polygon[0].latitude;
  const originLon = polygon[0].longitude;
  const points = polygon.map((p) =>
    latLonToLocalMeters(originLat, originLon, p.latitude, p.longitude)
  );
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.eastM * b.northM - b.eastM * a.northM;
  }
  return Math.abs(sum) / 2;
}

function withCanopyGeometry(
  tree: VegetationPoint,
  canopyPolygon: LatLon[],
  crownRadius: number,
  canopySource: CanopySource
): VegetationPoint {
  const canopyAreaM2 = polygonAreaM2(canopyPolygon);
  return {
    ...tree,
    canopyPolygon,
    crownRadius,
    canopyAreaM2,
    crownDiameterM: crownRadius * 2,
    canopySource,
  };
}

function isValidRing(ring: unknown): ring is LatLon[] {
  return Array.isArray(ring) && ring.length >= 3;
}

function isValidRadius(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Builds (or normalizes) a single tree's canopy polygon via the priority chain. */
export function buildTreeCanopy(tree: VegetationPoint): VegetationPoint {
  // 1. Real LiDAR-segmented crown polygon.
  if (tree.source === "nyc_lidar" && isValidRing(tree.canopyPolygon)) {
    const crownRadius = isValidRadius(tree.crownRadius)
      ? tree.crownRadius
      : Math.sqrt(polygonAreaM2(tree.canopyPolygon) / Math.PI);
    return withCanopyGeometry(tree, tree.canopyPolygon, crownRadius, "lidar_polygon");
  }

  // 2. A canopy polygon from any other API (forward-compatible; unused today).
  if (tree.source !== "nyc_lidar" && isValidRing(tree.canopyPolygon)) {
    const crownRadius = isValidRadius(tree.crownRadius)
      ? tree.crownRadius
      : Math.sqrt(polygonAreaM2(tree.canopyPolygon) / Math.PI);
    return withCanopyGeometry(tree, tree.canopyPolygon, crownRadius, "api_polygon");
  }

  // 3. A measured crown radius with no ring (e.g. LiDAR polygon dropped).
  if (isValidRadius(tree.crownRadius)) {
    const ring = generateEllipsePolygon(
      tree.latitude,
      tree.longitude,
      tree.crownRadius,
      tree.crownRadius
    );
    return withCanopyGeometry(tree, ring, tree.crownRadius, "crown_radius_circle");
  }

  // 4. Species/DBH-based ellipse estimate.
  const estimate = estimateCrownDiameter(tree.dbhInches, tree.species ?? tree.label, tree.treeHeight);
  if (estimate) {
    const semiMajorM = estimate.diameterM / 2;
    const semiMinorM = semiMajorM * estimate.aspectRatio;
    const ring = generateEllipsePolygon(tree.latitude, tree.longitude, semiMajorM, semiMinorM);
    const crownRadius = Math.sqrt(semiMajorM * semiMinorM);
    return withCanopyGeometry(tree, ring, crownRadius, "species_ellipse");
  }

  // 5. Last resort: fixed circle, unknown species and no DBH.
  const fallbackRadius = DEFAULT_CROWN_DIAMETER_M / 2;
  const ring = generateEllipsePolygon(tree.latitude, tree.longitude, fallbackRadius, fallbackRadius);
  return withCanopyGeometry(tree, ring, fallbackRadius, "circle_fallback");
}

export function buildTreeCanopies(features: VegetationFeature[]): VegetationFeature[] {
  return features.map((feature) => {
    if (
      feature.kind !== "point" ||
      (feature.category !== "tree" && feature.category !== "street_tree")
    ) {
      return feature;
    }
    return buildTreeCanopy(feature);
  });
}

export function buildCanopyReport(features: VegetationFeature[]): CanopyReport {
  const trees = features.filter(
    (feature): feature is VegetationPoint =>
      feature.kind === "point" &&
      (feature.category === "tree" || feature.category === "street_tree")
  );
  const count = (source: CanopySource) =>
    trees.filter((tree) => tree.canopySource === source).length;
  const areas = trees
    .map((t) => t.canopyAreaM2)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const diameters = trees
    .map((t) => t.crownDiameterM)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const avg = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    total: trees.length,
    lidarPolygon: count("lidar_polygon"),
    apiPolygon: count("api_polygon"),
    crownRadiusCircle: count("crown_radius_circle"),
    speciesEllipse: count("species_ellipse"),
    circleFallback: count("circle_fallback"),
    avgCanopyAreaM2: avg(areas),
    avgCrownDiameterM: avg(diameters),
  };
}
