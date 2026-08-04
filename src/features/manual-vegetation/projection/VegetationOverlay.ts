import * as Cesium from "cesium";
import { LonLat, ManualVegetationPolygon } from "../types/ManualVegetationTypes";
import { computePolygonCentroid } from "../services/PolygonGeometry";
import { lookupVegetationHeights, saveVegetationHeights } from "../services/vegetationHeightApi";

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

// Persists resolved terrain heights to localStorage — the polygons
// themselves were already saved there, but the expensive part (sampling
// real terrain elevation for each one) used to live only in an in-memory
// Map, redone from scratch on every single page load/reload. Terrain
// doesn't move, so once a polygon's height is known it's known forever
// (until the polygon's own position changes, which invalidates its cache
// entry via the id:updatedAt key) — no reason to keep re-querying it.
const HEIGHT_CACHE_STORAGE_KEY = "manual-veg-height-cache:v1";

function loadPersistedHeightCache(): Map<string, number> {
  try {
    const raw = localStorage.getItem(HEIGHT_CACHE_STORAGE_KEY);
    if (!raw) return new Map();
    const parsed: Record<string, number> = JSON.parse(raw);
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function savePersistedHeightCache(cache: Map<string, number>): void {
  try {
    localStorage.setItem(HEIGHT_CACHE_STORAGE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    // Storage full/unavailable — persistence is a pure optimization, safe to skip.
  }
}

/** Safety cap so awaiting tessellation readiness can never hang forever if a primitive's worker-side build stalls. */
const PRIMITIVE_READY_TIMEOUT_MS = 8000;
/** Polygons per chunk for the far-to-near progressive reveal — small enough that the first (farthest) chunk tessellates and appears quickly instead of waiting on the whole set at once. */
const CHUNK_SIZE = 6;

/**
 * `asynchronous: true` Primitives tessellate on a web worker — the
 * constructor returns immediately, but `.ready` only flips true once that
 * work actually lands, one or more frames later. Without awaiting this,
 * callers (renderSaved) resolved — and any "still loading" UI tied to that
 * promise closed — before the polygon was actually visible.
 */
function waitUntilPrimitiveReady(
  primitive: { ready: boolean },
  timeoutMs = PRIMITIVE_READY_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    function check() {
      if (primitive.ready || performance.now() - start > timeoutMs) {
        resolve();
        return;
      }
      requestAnimationFrame(check);
    }
    check();
  });
}

function cacheKey(p: ManualVegetationPolygon): string {
  return `${p.id}:${p.updatedAt}`;
}

/**
 * Synchronous, no network wait — whatever terrain detail is already loaded
 * for the current view. Used to get polygons drawn immediately; may be a
 * coarser LOD than sampleGroundHeightsPrecise below, especially right after
 * a camera move/rotation ends, when the most-detailed tiles for the new
 * view haven't streamed in yet.
 */
function fastGroundHeightsM(
  viewer: Cesium.Viewer,
  polygons: ManualVegetationPolygon[],
  cache: Map<string, number>
): Map<string, number> {
  const heights = new Map<string, number>();
  for (const polygon of polygons) {
    const cached = cache.get(cacheKey(polygon));
    if (cached !== undefined) {
      heights.set(polygon.id, cached);
      continue;
    }
    const centroid = computePolygonCentroid(polygon.positions);
    const cartographic = Cesium.Cartographic.fromDegrees(centroid.longitude, centroid.latitude);
    const loadedHeight = viewer.scene.globe.getHeight(cartographic);
    const height = (Number.isFinite(loadedHeight) ? loadedHeight : undefined) ?? 0;
    heights.set(polygon.id, height + HEIGHT_OFFSET_M);
    // Deliberately NOT cached here — this is a fast-but-possibly-coarse
    // reading; only the precise sampled value below gets cached, so a
    // later call still upgrades it instead of treating this as final.
  }
  return heights;
}

/**
 * Same terrain-height resolution TreeRenderer.ts uses for trees — real,
 * most-detailed absolute elevation, not ground-clamping. This is the slow
 * path (network/tile-dependent, can take a while right after a camera
 * move) — callers should show fastGroundHeightsM's result first and treat
 * this as a background upgrade, not something to block the first paint on.
 */
async function sampleGroundHeightsPrecise(
  viewer: Cesium.Viewer,
  polygons: ManualVegetationPolygon[],
  cache: Map<string, number>
): Promise<Map<string, number>> {
  let uncached = polygons.filter((p) => !cache.has(cacheKey(p)));

  // Check the shared backend cache next — a real terrain sample
  // (sampleTerrainMostDetailed below) is a slow, tile-dependent network
  // call; if ANY previous visitor (any browser, not just this one) already
  // resolved this exact polygon+position, reuse that instead of re-doing
  // the measurement ourselves.
  if (uncached.length > 0) {
    try {
      const resolved = await lookupVegetationHeights(
        uncached.map((p) => ({ polygonId: p.id, clientUpdatedAt: p.updatedAt }))
      );
      for (const { polygonId, clientUpdatedAt, heightM } of resolved) {
        cache.set(`${polygonId}:${clientUpdatedAt}`, heightM);
      }
      uncached = uncached.filter((p) => !cache.has(cacheKey(p)));
    } catch (error) {
      // Backend unreachable — fall through to real terrain sampling below,
      // same as any other network failure this module already tolerates.
      // eslint-disable-next-line no-console
      console.warn("[ManualVegetation] Backend height lookup failed; sampling terrain directly", error);
    }
  }

  if (uncached.length > 0) {
    const cartographics = uncached.map((polygon) => {
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

    const newlyResolved: { polygonId: string; clientUpdatedAt: number; heightM: number }[] = [];
    uncached.forEach((polygon, index) => {
      const sampledHeight = sampled[index]?.height;
      const loadedHeight = viewer.scene.globe.getHeight(cartographics[index]);
      const height =
        (Number.isFinite(sampledHeight) ? sampledHeight : undefined) ??
        (Number.isFinite(loadedHeight) ? loadedHeight : undefined) ??
        0;
      const heightM = height + HEIGHT_OFFSET_M;
      cache.set(cacheKey(polygon), heightM);
      newlyResolved.push({ polygonId: polygon.id, clientUpdatedAt: polygon.updatedAt, heightM });
    });
    // Persist right away — a newly-resolved height should survive a reload
    // even if the user navigates away before this polygon set is touched
    // again.
    savePersistedHeightCache(cache);
    // Fire-and-forget: pushes this measurement up so every FUTURE visitor
    // (not just this browser) skips re-sampling terrain for these exact
    // polygons too. A failure here just means the next visitor re-measures
    // — never something worth blocking or retrying for.
    void saveVegetationHeights(newlyResolved).catch((error) => {
      // eslint-disable-next-line no-console
      console.warn("[ManualVegetation] Failed to save resolved heights to the backend", error);
    });
  }

  const heights = new Map<string, number>();
  polygons.forEach((polygon) => {
    heights.set(polygon.id, cache.get(cacheKey(polygon)) ?? HEIGHT_OFFSET_M);
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
  // One fill Primitive per chunk (see drawSavedChunked) instead of a single
  // Primitive for every saved polygon — splitting it up is what lets the
  // farthest chunk finish tessellating and appear on screen while nearer
  // chunks are still building, instead of nothing appearing until the
  // entire set finishes at once.
  private savedPrimitives: Cesium.Primitive[] = [];
  private draftPrimitive: Cesium.Primitive | null = null;
  private handleIds: string[] = [];
  private outlineIds: string[] = [];
  private renderGeneration = 0;
  // Resolved heights rarely change (terrain doesn't move) — keyed by
  // `id:updatedAt` so a polygon only re-samples terrain when its own
  // position actually changes, instead of every polygon re-sampling on
  // every renderSaved call (e.g. dragging one vertex was re-sampling
  // terrain for ALL saved polygons on every mouse-move). Seeded from
  // localStorage so this survives page reloads too, not just this session.
  private readonly heightCache = loadPersistedHeightCache();

  constructor(private readonly viewer: Cesium.Viewer) {
    viewer.scene.primitives.add(this.primitives);
  }

  private buildOutline(polygon: ManualVegetationPolygon, selectedId: string | null, heightM: number): void {
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

  /**
   * Clears everything, then rebuilds in chunks ordered farthest-from-camera
   * first. Each chunk's outlines are added immediately (cheap Entity
   * polylines, no tessellation wait) and its fill Primitive is built and
   * awaited before starting the next chunk — so the farthest polygons
   * visibly appear first while nearer ones are still tessellating, instead
   * of the whole set staying invisible until one giant Primitive finishes.
   * Aborts between chunks if `generation` has been superseded by a newer
   * renderSaved call.
   */
  private async drawSavedChunked(
    polygons: ManualVegetationPolygon[],
    selectedId: string | null,
    heights: Map<string, number>,
    generation: number
  ): Promise<void> {
    this.savedPrimitives.forEach((p) => this.primitives.remove(p));
    this.savedPrimitives = [];
    this.outlineIds.forEach((id) => this.viewer.entities.removeById(id));
    this.outlineIds = [];

    const cameraPosition = this.viewer.camera.positionWC;
    const ordered = polygons
      .filter((p) => p.positions.length >= 3)
      .map((polygon) => {
        const heightM = heights.get(polygon.id) ?? HEIGHT_OFFSET_M;
        const centroid = computePolygonCentroid(polygon.positions);
        const world = Cesium.Cartesian3.fromDegrees(centroid.longitude, centroid.latitude, heightM);
        return { polygon, heightM, distance: Cesium.Cartesian3.distance(cameraPosition, world) };
      })
      // Far-to-near: farthest polygons finish tessellating and appear
      // first, since they're the ones most likely already fully visible/
      // unobstructed in the current view right after a rotation.
      .sort((a, b) => b.distance - a.distance);

    for (let i = 0; i < ordered.length; i += CHUNK_SIZE) {
      if (generation !== this.renderGeneration) return;
      const chunk = ordered.slice(i, i + CHUNK_SIZE);

      const instances: Cesium.GeometryInstance[] = [];
      for (const { polygon, heightM } of chunk) {
        this.buildOutline(polygon, selectedId, heightM);
        try {
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
      if (instances.length === 0) continue;

      const chunkPrimitive = new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, flat: true }),
        asynchronous: true,
      });
      this.primitives.add(chunkPrimitive);
      this.savedPrimitives.push(chunkPrimitive);
      await waitUntilPrimitiveReady(chunkPrimitive);
    }
  }

  /**
   * Two-phase render: draws immediately using whatever terrain detail is
   * already loaded (synchronous, no network wait), then upgrades to precise
   * sampled heights in the background. Right after a camera rotation ends,
   * the most-detailed tiles for the new view often haven't streamed in yet
   * — blocking the whole polygon render on that (the old behavior) is what
   * made polygons take a while to appear right after rotating. Now they
   * appear instantly at a "close enough" height and quietly self-correct a
   * moment later only if the precise height actually differs. Both passes
   * go through drawSavedChunked, so both also get the far-to-near
   * progressive reveal instead of popping in all at once.
   */
  async renderSaved(polygons: ManualVegetationPolygon[], selectedId: string | null): Promise<void> {
    const generation = ++this.renderGeneration;

    if (polygons.length === 0) {
      this.savedPrimitives.forEach((p) => this.primitives.remove(p));
      this.savedPrimitives = [];
      this.outlineIds.forEach((id) => this.viewer.entities.removeById(id));
      this.outlineIds = [];
      return;
    }

    const fastHeights = fastGroundHeightsM(this.viewer, polygons, this.heightCache);
    await this.drawSavedChunked(polygons, selectedId, fastHeights, generation);
    if (generation !== this.renderGeneration) return;

    const preciseHeights = await sampleGroundHeightsPrecise(this.viewer, polygons, this.heightCache);
    // A newer call landed while sampling was in flight — drop this one.
    if (generation !== this.renderGeneration) return;

    const changed = polygons.some(
      (p) => Math.abs((preciseHeights.get(p.id) ?? 0) - (fastHeights.get(p.id) ?? 0)) > 0.05
    );
    if (changed) await this.drawSavedChunked(polygons, selectedId, preciseHeights, generation);
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

  /** Cheap live-feedback move of a single handle entity during a drag — no terrain sampling, no fill/outline rebuild. */
  moveHandle(polygonId: string, vertexIndex: number, point: LonLat): void {
    const id = `${HANDLE_PREFIX}${polygonId}-${vertexIndex}`;
    const entity = this.viewer.entities.getById(id);
    if (!entity) return;
    entity.position = new Cesium.ConstantPositionProperty(
      Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude)
    );
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
    this.savedPrimitives.forEach((p) => this.primitives.remove(p));
    this.savedPrimitives = [];
    if (this.draftPrimitive) this.primitives.remove(this.draftPrimitive);
    this.handleIds.forEach((id) => this.viewer.entities.removeById(id));
    this.outlineIds.forEach((id) => this.viewer.entities.removeById(id));
    this.viewer.entities.removeById(DRAFT_ID);
    if (!this.primitives.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.primitives);
    }
  }
}
