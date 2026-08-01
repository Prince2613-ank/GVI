import * as Cesium from "cesium";
import { ManualVegetationPolygon } from "../types/ManualVegetationTypes";
import { computePolygonAreaM2, computePolygonCentroid } from "./PolygonGeometry";

export interface DiagnosticsStage {
  label: string;
  passed: boolean;
  details: string;
}

export interface DiagnosticsReport {
  polygonId: string;
  stages: DiagnosticsStage[];
}

const DIAGNOSTICS_PREFIX = "manual-veg-diag-";

function boundingRectangle(polygon: ManualVegetationPolygon) {
  const lons = polygon.positions.map((p) => p.longitude);
  const lats = polygon.positions.map((p) => p.latitude);
  return {
    minLon: Math.min(...lons),
    maxLon: Math.max(...lons),
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
  };
}

/**
 * Runs the exact pipeline described for debugging why manual vegetation
 * polygons don't appear: logs every stage's data to console AND draws
 * physical debug primitives/entities on the globe for each stage (red
 * vertex points, red outline, extruded test box, bounding sphere, an
 * Entity-API copy alongside the Primitive-API copy). Nothing here replaces
 * VegetationOverlay's actual rendering — this is a separate, disposable
 * instrument you clear when done.
 */
export async function runPolygonDiagnostics(
  viewer: Cesium.Viewer,
  polygon: ManualVegetationPolygon
): Promise<DiagnosticsReport> {
  const stages: DiagnosticsStage[] = [];
  const log = (...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.log("[PolygonDiagnostics]", ...args);
  };

  // ===== STEP 1 — verify data =====
  const rect = boundingRectangle(polygon);
  const area = computePolygonAreaM2(polygon.positions);
  const centroid = computePolygonCentroid(polygon.positions);
  log("STEP 1 — Manual Vegetation");
  log("  Polygon ID:", polygon.id);
  log("  Name:", polygon.name);
  log("  Vertices:", polygon.positions.length);
  polygon.positions.forEach((p, i) =>
    log(`  [${i}] Lon: ${p.longitude.toFixed(7)}  Lat: ${p.latitude.toFixed(7)}`)
  );
  log("  Bounding rect:", rect);
  log("  Area m^2:", area.toFixed(2));
  log("  Centroid:", centroid);
  stages.push({
    label: "GeoJSON data valid",
    passed: polygon.positions.length >= 3 && Number.isFinite(area) && area > 0,
    details: `${polygon.positions.length} vertices, area ${area.toFixed(2)} m²`,
  });

  // ===== STEP 3 (+12) — verify terrain sampling =====
  const cartographics = polygon.positions.map((p) =>
    Cesium.Cartographic.fromDegrees(p.longitude, p.latitude)
  );
  let sampled: Cesium.Cartographic[] = [];
  let sampleError: string | null = null;
  try {
    sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartographics.slice());
  } catch (error) {
    sampleError = error instanceof Error ? error.message : String(error);
  }

  const finalHeights: number[] = [];
  log("STEP 3 — Terrain sampling per vertex");
  polygon.positions.forEach((_, i) => {
    const sampledHeight = sampled[i]?.height;
    const loadedHeight = viewer.scene.globe.getHeight(cartographics[i]);
    const finalHeight =
      (Number.isFinite(sampledHeight) ? sampledHeight : undefined) ??
      (Number.isFinite(loadedHeight) ? loadedHeight : undefined) ??
      0;
    finalHeights.push(finalHeight);
    log(
      `  [${i}] sampledTerrainHeight=${sampledHeight ?? "n/a"} loadedGlobeHeight=${
        loadedHeight ?? "n/a"
      } finalHeightUsed=${finalHeight.toFixed(2)}`
    );
  });
  if (sampleError) log("  sampleTerrainMostDetailed FAILED, used fallback:", sampleError);

  const minHeight = Math.min(...finalHeights);
  const maxHeight = Math.max(...finalHeights);
  const avgHeight = finalHeights.reduce((a, b) => a + b, 0) / finalHeights.length;
  log("STEP 12 — Height summary", { minHeight, maxHeight, avgHeight });
  const heightsValid =
    finalHeights.every((h) => Number.isFinite(h) && h !== -9999) &&
    Number.isFinite(minHeight) &&
    Number.isFinite(maxHeight);
  stages.push({
    label: "Terrain heights valid (no NaN/-9999)",
    passed: heightsValid,
    details: `min=${minHeight.toFixed(2)} max=${maxHeight.toFixed(2)} avg=${avgHeight.toFixed(2)}`,
  });
  if (!heightsValid) {
    log("❌ Height data invalid — stopping further stage rendering, returning early");
    stages.push({ label: "Aborted after invalid height", passed: false, details: "" });
    return { polygonId: polygon.id, stages };
  }

  const positionsAtHeight = polygon.positions.map((p, i) =>
    Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, finalHeights[i])
  );

  // ===== STEP 13 — screen projection =====
  log("STEP 13 — Screen projection (wgs84/world -> window coordinates)");
  const windowCoords = positionsAtHeight.map((pos, i) => {
    const w = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, pos);
    log(`  [${i}] window=${w ? `${w.x.toFixed(1)}, ${w.y.toFixed(1)}` : "NULL"}`);
    return w;
  });
  const allNull = windowCoords.every((w) => !w);
  stages.push({
    label: "Vertices project on-screen",
    passed: !allNull,
    details: allNull
      ? "ALL vertices projected null — polygon is behind the camera, or coordinates are invalid"
      : `${windowCoords.filter(Boolean).length}/${windowCoords.length} projected on-screen`,
  });

  // Clear any previous diagnostics run before drawing new ones.
  clearDiagnostics(viewer);

  // ===== STEP 4 — debug points at every vertex =====
  positionsAtHeight.forEach((pos, i) => {
    viewer.entities.add({
      id: `${DIAGNOSTICS_PREFIX}point-${i}`,
      position: pos,
      point: {
        pixelSize: 12,
        color: Cesium.Color.RED,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  });
  stages.push({
    label: "Debug vertex points drawn",
    passed: true,
    details: `${positionsAtHeight.length} point(s) added — if these aren't visible, coordinate conversion itself is broken`,
  });

  // ===== STEP 5 — outline only (bright red, closed) =====
  const closedLoop = [...positionsAtHeight, positionsAtHeight[0]];
  viewer.entities.add({
    id: `${DIAGNOSTICS_PREFIX}outline`,
    polyline: {
      positions: closedLoop,
      width: 4,
      material: Cesium.Color.RED,
    },
  });
  stages.push({
    label: "Debug outline drawn",
    passed: true,
    details: "If the outline shows but no fill ever does, the problem is polygon geometry/appearance, not position",
  });

  // ===== STEP 6 — extruded test (always-visible normal 3D geometry) =====
  try {
    const extrudedInstance = new Cesium.GeometryInstance({
      geometry: new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(positionsAtHeight),
        perPositionHeight: true,
        extrudedHeight: maxHeight + 5,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.LIME.withAlpha(0.9)),
      },
    });
    const extrudedPrimitive = new Cesium.Primitive({
      geometryInstances: extrudedInstance,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, flat: true }),
      asynchronous: false,
    });
    viewer.scene.primitives.add(extrudedPrimitive);
    (extrudedPrimitive as unknown as { __diagId: string }).__diagId = `${DIAGNOSTICS_PREFIX}extruded`;
    diagnosticPrimitives.push(extrudedPrimitive);
    stages.push({
      label: "Extruded test box created",
      passed: true,
      details: "Solid green box, +5m tall — if THIS doesn't appear, basic Primitive/PolygonGeometry rendering is broken entirely (not specific to flat ground fills)",
    });
  } catch (error) {
    stages.push({
      label: "Extruded test box created",
      passed: false,
      details: error instanceof Error ? error.message : String(error),
    });
  }

  // ===== STEP 8 — bounding sphere =====
  const boundingSphere = Cesium.BoundingSphere.fromPoints(positionsAtHeight);
  viewer.entities.add({
    id: `${DIAGNOSTICS_PREFIX}bounding-sphere`,
    position: boundingSphere.center,
    ellipsoid: {
      radii: new Cesium.Cartesian3(5, 5, 5),
      material: Cesium.Color.YELLOW.withAlpha(0.9),
    },
  });
  stages.push({
    label: "Bounding sphere center drawn",
    passed: true,
    details: `radius=${boundingSphere.radius.toFixed(1)}m — a small yellow sphere at the polygon's true center`,
  });

  // ===== STEP 9 — Entity-API copy alongside the Primitive-API copy =====
  viewer.entities.add({
    id: `${DIAGNOSTICS_PREFIX}entity-version`,
    polygon: {
      hierarchy: positionsAtHeight,
      perPositionHeight: true,
      material: Cesium.Color.GREEN.withAlpha(0.5),
      outline: true,
      outlineColor: Cesium.Color.RED,
    },
  });
  try {
    const primitiveInstance = new Cesium.GeometryInstance({
      geometry: new Cesium.PolygonGeometry({
        polygonHierarchy: new Cesium.PolygonHierarchy(positionsAtHeight),
        perPositionHeight: true,
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      }),
      attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.BLUE.withAlpha(0.5)),
      },
    });
    const primitiveVersion = new Cesium.Primitive({
      geometryInstances: primitiveInstance,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, flat: true }),
      asynchronous: false,
    });
    viewer.scene.primitives.add(primitiveVersion);
    diagnosticPrimitives.push(primitiveVersion);
    stages.push({
      label: "Entity + Primitive comparison drawn",
      passed: true,
      details: "GREEN (red outline) = Entity API. BLUE = Primitive API, offset shouldn't overlap exactly — compare which one you actually see",
    });
  } catch (error) {
    stages.push({
      label: "Entity + Primitive comparison drawn",
      passed: false,
      details: error instanceof Error ? error.message : String(error),
    });
  }

  log("STEP 14 — Summary");
  stages.forEach((s) => log(`  ${s.passed ? "✅" : "❌"} ${s.label} — ${s.details}`));

  return { polygonId: polygon.id, stages };
}

const diagnosticPrimitives: Cesium.Primitive[] = [];

/** Removes every entity/primitive the diagnostics run added. */
export function clearDiagnostics(viewer: Cesium.Viewer): void {
  const toRemove = viewer.entities.values.filter((e) => e.id.toString().startsWith(DIAGNOSTICS_PREFIX));
  toRemove.forEach((e) => viewer.entities.remove(e));
  diagnosticPrimitives.forEach((p) => {
    if (!p.isDestroyed()) viewer.scene.primitives.remove(p);
  });
  diagnosticPrimitives.length = 0;
}

/** Flies the camera to frame a polygon exactly — confirms its real location regardless of rendering. */
export function flyToPolygon(viewer: Cesium.Viewer, polygon: ManualVegetationPolygon): void {
  const positions = polygon.positions.map((p) => Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude));
  const sphere = Cesium.BoundingSphere.fromPoints(positions);
  viewer.camera.flyToBoundingSphere(sphere, { duration: 1.5 });
}
