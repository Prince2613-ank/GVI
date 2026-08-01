import * as Cesium from "cesium";
import { LonLat, ManualVegetationPolygon } from "../types/ManualVegetationTypes";
import { computePolygonCentroid } from "../services/PolygonGeometry";

// Matches TreeRenderer's actual canopy palette (see treeSpecies.ts's
// GENERIC profile: HSL [0.32, 0.42, 0.3], a muted natural forest green) —
// Color.LIME (a flat, saturated neon green) visually clashed with every
// real tree in the scene, reading as a completely different, artificial
// material rather than "more vegetation".
const FILL_COLOR = Cesium.Color.fromHsl(0.32, 0.42, 0.3, 0.5);
// A warmer, still-muted amber (not a bright saturated yellow) so the
// selected polygon is still clearly distinguishable without reintroducing
// the same "doesn't belong in this scene" clash.
const SELECTED_COLOR = Cesium.Color.fromCssColorString("#d9a441").withAlpha(0.6);
const OUTLINE_COLOR = Cesium.Color.fromHsl(0.32, 0.5, 0.42);
const SAVED_PREFIX = "manual-veg-";
const OUTLINE_PREFIX = "manual-veg-outline-";
const HANDLE_PREFIX = "manual-veg-handle-";
const DRAFT_ID = "manual-veg-draft";
/** Lifted slightly above the sampled terrain height so the fill doesn't z-fight with the ground/imagery. */
const HEIGHT_OFFSET_M = 0.4;
/**
 * Saved/draft polygons are extruded to this height instead of drawn as a
 * flat sliver — a paper-thin shape right at ground level was easy for
 * buildings/terrain to partially occlude depending on viewing angle,
 * reading as "not completely visible as drawn". A real 10m volume is both
 * what was asked for and the actual visibility fix: normal depth testing
 * still applies, but there's a solid extruded block to test against
 * instead of a near-zero-thickness plane.
 */
const POLYGON_HEIGHT_M = 10;

function toCartesianArray(positions: LonLat[], heightM: number): Cesium.Cartesian3[] {
  return positions.map((p) => Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude, heightM));
}

/** Same terrain-height resolution TreeRenderer.ts uses for trees — real absolute elevation, not ground-clamping. */
async function resolveGroundHeightsM(
  viewer: Cesium.Viewer,
  polygons: ManualVegetationPolygon[]
): Promise<Map<string, number>> {
  const cartographics = polygons.map((polygon) => {
    const centroid = computePolygonCentroid(polygon.positions);
    return Cesium.Cartographic.fromDegrees(centroid.longitude, centroid.latitude);
  });

  let sampled: Cesium.Cartographic[] = [];
  try {
    sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartographics.slice());
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      "[ManualVegetation] Most-detailed terrain sampling failed; using loaded globe elevation",
      error
    );
  }

  const heights = new Map<string, number>();
  polygons.forEach((polygon, index) => {
    const sampledHeight = sampled[index]?.height;
    const loadedHeight = viewer.scene.globe.getHeight(cartographics[index]);
    const height =
      (Number.isFinite(sampledHeight) ? sampledHeight : undefined) ??
      (Number.isFinite(loadedHeight) ? loadedHeight : undefined) ??
      0;
    heights.set(polygon.id, height + HEIGHT_OFFSET_M);
  });
  return heights;
}

/**
 * Owns every Cesium primitive/entity the manual vegetation mapper draws.
 *
 * Saved polygon fills are placed at their REAL, absolute terrain elevation
 * (sampled the same way TreeRenderer.ts places trees) and rendered as a
 * plain `Cesium.Primitive` — not a GroundPrimitive, and not
 * heightReference-clamped. Both of those rely on Cesium's ground-clamping/
 * classification pipeline, which needs specific WebGL depth-texture support
 * that isn't guaranteed on every machine; a plain, absolutely-positioned
 * primitive uses the same ordinary depth-tested rendering as the tree
 * crowns that are already confirmed visible, so it doesn't depend on that
 * pipeline at all. Vertex handles stay on the Entity API (points don't
 * need classification to clamp to terrain — a separate, simpler code path).
 */
export class ManualVegetationOverlay {
  private readonly primitives = new Cesium.PrimitiveCollection();
  private savedPrimitive: Cesium.Primitive | null = null;
  private draftPrimitive: Cesium.Primitive | null = null;
  private handleIds: string[] = [];
  private outlineIds: string[] = [];
  private renderGeneration = 0;

  constructor(private readonly viewer: Cesium.Viewer) {
    viewer.scene.primitives.add(this.primitives);
  }

  async renderSaved(polygons: ManualVegetationPolygon[], selectedId: string | null): Promise<void> {
    const generation = ++this.renderGeneration;
    // eslint-disable-next-line no-console
    console.log("[ManualVegetation][renderSaved] called", {
      generation,
      polygonCount: polygons.length,
      overlayPrimitivesInScene: this.viewer.scene.primitives.contains(this.primitives),
      overlayPrimitivesShow: this.primitives.show,
      sceneTopLevelPrimitiveCount: this.viewer.scene.primitives.length,
    });

    if (this.savedPrimitive) {
      this.primitives.remove(this.savedPrimitive);
      this.savedPrimitive = null;
    }
    if (polygons.length === 0) {
      this.outlineIds.forEach((id) => this.viewer.entities.removeById(id));
      this.outlineIds = [];
      // eslint-disable-next-line no-console
      console.log("[ManualVegetation][renderSaved] polygons.length === 0 — clearing fill, generation", generation);
      return;
    }

    const heights = await resolveGroundHeightsM(this.viewer, polygons);
    // A newer call landed while this terrain sampling was in flight — drop this one.
    if (generation !== this.renderGeneration) {
      // eslint-disable-next-line no-console
      console.log(
        "[ManualVegetation][renderSaved] STALE — a newer renderSaved call superseded this one",
        { thisGeneration: generation, currentGeneration: this.renderGeneration }
      );
      return;
    }

    // Bright, always-on outline for EVERY saved polygon (not just the
    // selected one) — the translucent fill alone blends into olive-green
    // rooftop imagery and is easy to miss on a single Analyze click.
    this.outlineIds.forEach((id) => this.viewer.entities.removeById(id));
    this.outlineIds = [];
    for (const polygon of polygons) {
      if (polygon.positions.length < 3) continue;
      const heightM = heights.get(polygon.id) ?? HEIGHT_OFFSET_M;
      const closedLoop = [...toCartesianArray(polygon.positions, heightM), toCartesianArray([polygon.positions[0]], heightM)[0]];
      const id = `${OUTLINE_PREFIX}${polygon.id}`;
      this.viewer.entities.add({
        id,
        polyline: {
          positions: closedLoop,
          width: polygon.id === selectedId ? 4 : 2.5,
          material: polygon.id === selectedId ? SELECTED_COLOR.withAlpha(1) : OUTLINE_COLOR,
        },
      });
      this.outlineIds.push(id);
    }

    const instances: Cesium.GeometryInstance[] = [];
    for (const polygon of polygons) {
      if (polygon.positions.length < 3) continue;
      try {
        const heightM = heights.get(polygon.id) ?? HEIGHT_OFFSET_M;
        instances.push(
          new Cesium.GeometryInstance({
            id: `${SAVED_PREFIX}${polygon.id}`,
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(
                toCartesianArray(polygon.positions, heightM)
              ),
              height: heightM,
              extrudedHeight: heightM + POLYGON_HEIGHT_M,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                polygon.id === selectedId ? SELECTED_COLOR : FILL_COLOR
              ),
            },
          })
        );
      } catch (error) {
        // One malformed (e.g. self-intersecting) hand-drawn polygon must
        // never stop every OTHER saved polygon from rendering.
        // eslint-disable-next-line no-console
        console.warn(`Failed to build geometry for manual vegetation polygon "${polygon.name}":`, error);
      }
    }
    if (instances.length === 0) return;

    this.savedPrimitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, flat: true }),
      asynchronous: true,
    });
    this.primitives.add(this.savedPrimitive);
    // eslint-disable-next-line no-console
    console.log("[ManualVegetation][renderSaved] fill primitive added", {
      generation,
      instanceCount: instances.length,
      overlayPrimitivesInScene: this.viewer.scene.primitives.contains(this.primitives),
      overlayPrimitivesShow: this.primitives.show,
      overlayPrimitivesLength: this.primitives.length,
    });
  }

  async renderDraft(points: LonLat[]): Promise<void> {
    this.viewer.entities.removeById(DRAFT_ID);
    if (this.draftPrimitive) {
      this.primitives.remove(this.draftPrimitive);
      this.draftPrimitive = null;
    }
    if (points.length === 0) return;

    // The polyline preview traces click order exactly — clampToGround on a
    // polyline is a separately (and reliably) supported Entity feature.
    this.viewer.entities.add({
      id: DRAFT_ID,
      polyline: {
        positions: toCartesianArray(points, 0),
        width: 3,
        material: OUTLINE_COLOR,
        clampToGround: true,
      },
    });

    if (points.length >= 3) {
      const centroid = computePolygonCentroid(points);
      const cartographic = Cesium.Cartographic.fromDegrees(centroid.longitude, centroid.latitude);
      const loadedHeight = this.viewer.scene.globe.getHeight(cartographic) ?? 0;
      const draftBaseHeightM = loadedHeight + HEIGHT_OFFSET_M;
      try {
        this.draftPrimitive = new Cesium.Primitive({
          geometryInstances: new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(
                toCartesianArray(points, draftBaseHeightM)
              ),
              height: draftBaseHeightM,
              extrudedHeight: draftBaseHeightM + POLYGON_HEIGHT_M,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(FILL_COLOR),
            },
          }),
          appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, flat: true }),
          asynchronous: true,
        });
        this.primitives.add(this.draftPrimitive);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("Failed to build draft vegetation polygon preview:", error);
      }
    }
  }

  /** Draggable vertex handles for the polygon currently selected for editing. */
  renderHandles(polygon: ManualVegetationPolygon | null): void {
    this.handleIds.forEach((id) => this.viewer.entities.removeById(id));
    this.handleIds = [];
    if (!polygon) return;

    polygon.positions.forEach((p, index) => {
      const id = `${HANDLE_PREFIX}${polygon.id}-${index}`;
      this.viewer.entities.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(p.longitude, p.latitude),
        point: {
          pixelSize: 10,
          color: Cesium.Color.WHITE,
          outlineColor: OUTLINE_COLOR,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
      });
      this.handleIds.push(id);
    });
  }

  static idToPolygonId(entityId: string): string | null {
    if (entityId.startsWith(OUTLINE_PREFIX)) return entityId.slice(OUTLINE_PREFIX.length);
    if (!entityId.startsWith(SAVED_PREFIX)) return null;
    return entityId.slice(SAVED_PREFIX.length);
  }

  static parseHandleId(entityId: string): { polygonId: string; vertexIndex: number } | null {
    if (!entityId.startsWith(HANDLE_PREFIX)) return null;
    const rest = entityId.slice(HANDLE_PREFIX.length);
    const lastDash = rest.lastIndexOf("-");
    if (lastDash === -1) return null;
    const polygonId = rest.slice(0, lastDash);
    const vertexIndex = Number(rest.slice(lastDash + 1));
    if (!Number.isFinite(vertexIndex)) return null;
    return { polygonId, vertexIndex };
  }

  destroy(): void {
    if (this.savedPrimitive) this.primitives.remove(this.savedPrimitive);
    if (this.draftPrimitive) this.primitives.remove(this.draftPrimitive);
    this.handleIds.forEach((id) => this.viewer.entities.removeById(id));
    this.outlineIds.forEach((id) => this.viewer.entities.removeById(id));
    this.viewer.entities.removeById(DRAFT_ID);
    if (!this.primitives.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.primitives);
    }
  }
}
