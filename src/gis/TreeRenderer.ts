import * as Cesium from "cesium";
import { VegetationPoint } from "../services/vegetation";
import {
  DEFAULT_TREE_HEIGHT_M,
  isValidTreeHeight,
} from "../services/treeHeight";
import { buildCrownInstances, buildTrunkInstance, Tessellation } from "./treeGeometry";
import { getSpeciesBillboardImage } from "./treeBillboard";
import { resolveImperfections, resolveSpeciesProfile } from "./treeSpecies";

const MAX_DETAILED_TREES = 10_000;
/** Safety cap so a render() await can never hang forever if a primitive's worker-side tessellation stalls. */
const PRIMITIVE_READY_TIMEOUT_MS = 8000;

// LOD tier bounds. Trees are bucketed once, at render() time, by their
// distance from the camera at that moment — the same approach the original
// two-tier (detailed/far) split used, just with more tiers. Each instance
// also carries a matching DistanceDisplayCondition (a standard, built-in
// Cesium per-instance attribute — see treeGeometry.ts), which is what
// actually keeps it correctly shown/hidden live, every frame, as the camera
// moves afterward without requiring a fresh render() call — the
// render()-time bucketing only decides which LOD *tier of geometry to
// build* for each tree, not the moment-to-moment show/hide behavior.
const LOD0_DISTANCE_M = 150; // trunk + full-detail crown
const LOD1_DISTANCE_M = 300; // trunk + medium-detail crown — matches the "always higher LOD within 300m of a balcony" requirement
const LOD2_DISTANCE_M = 600; // crown-only, coarse, no trunk
const LOD3_DISTANCE_M = 3000; // billboard impostor
// Beyond LOD3_DISTANCE_M: nothing rendered (LOD4/hidden).

export interface TreeHoverInfo {
  treeId: string;
  species: string;
  heightM: number;
  canopyWidthM: number;
  health: "Healthy" | "Stressed" | "Poor";
  age: "Young" | "Mature" | "Old";
  /** Rough estimate, not measured data — this app has no real carbon-uptake API. */
  estimatedCarbonKgPerYear: number;
  source: VegetationPoint["source"];
}

interface PlacedTree {
  tree: VegetationPoint;
  groundHeight: number;
  treeHeight: number;
}

/** One tree's registered pickable/highlightable geometry, for hover. baseColor is captured lazily on first highlight (see applyHighlight) since attributes aren't queryable until the owning Primitive is .ready. */
interface TreeInstanceRef {
  primitive: Cesium.Primitive;
  instanceId: string;
  baseColor: Cesium.Color | null;
}

/**
 * Cesium's batched Primitive/GroundPrimitive geometry is tessellated
 * asynchronously (on a web worker) — the constructor returns immediately,
 * but `.ready` only flips to true once that work actually lands, one or
 * more render frames later. Capturing a screenshot right after render()
 * used to return (before this) could catch trees mid-tessellation, i.e.
 * invisible, which is exactly what caused GVI scores to come out low/false.
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

function estimateCarbonKgPerYear(heightM: number, canopyWidthM: number): number {
  // Widely-cited rough urban-tree rule of thumb (e.g. USDA Forest Service
  // i-Tree-style estimates land in this range for street trees): larger
  // canopy volume absorbs more. This is a coarse approximation for display
  // purposes only, not a scientific carbon accounting figure.
  const canopyVolumeProxy = heightM * canopyWidthM * canopyWidthM;
  return Math.round(canopyVolumeProxy * 0.35 * 10) / 10;
}

/**
 * Resolves terrain elevation before creating batched tree geometry. Trunk
 * geometry starts at exactly groundHeight and the crown top is exactly
 * groundHeight + treeHeight.
 */
export class TreeRenderer {
  private readonly primitives = new Cesium.PrimitiveCollection();
  private renderGeneration = 0;
  private readonly placedTreesById = new Map<string, PlacedTree>();
  private readonly instancesByTreeId = new Map<string, TreeInstanceRef[]>();
  private hoveredTreeId: string | null = null;
  // Distant trees (LOD3) are unlit billboard sprites — unlike the nearer
  // LOD0-2 tiers, which use PerInstanceColorAppearance's Phong shading and
  // so already respond to scene.light automatically, billboards ignore
  // scene lighting entirely. Tracked here so a day/night tint can be
  // applied to them directly (see setNightTint), the same reason the OSM
  // Buildings tileset needed direct tinting instead of relying on the
  // scene light.
  private readonly billboardCollections: Cesium.BillboardCollection[] = [];
  // Resolved ground elevations persist across render() calls, keyed by
  // tree id — terrain doesn't move, so a tree whose height was already
  // sampled once (this session) never needs to re-sample it. Without this,
  // every render() (e.g. re-opening a preview, first "Analyze Nearby
  // Vegetation") redid a full sampleTerrainMostDetailed pass for every
  // tree even when nothing had changed, which is what made trees visibly
  // clear and rebuild ("reload") each time.
  private readonly groundHeightCache = new Map<string, number>();

  constructor(private readonly viewer: Cesium.Viewer) {
    viewer.scene.primitives.add(this.primitives);
  }

  /**
   * Two-phase: builds and shows trees immediately using whatever terrain
   * detail is already loaded/cached (no network wait), then re-samples
   * precise heights for any tree not already in groundHeightCache in the
   * background and only rebuilds if a height actually changed enough to
   * matter. This is what makes a re-render (re-opening a preview, first
   * "Analyze Nearby Vegetation" after a rotation) show trees instantly
   * instead of clearing the scene and waiting on terrain sampling for
   * every tree before anything reappears.
   */
  async render(trees: VegetationPoint[]): Promise<void> {
    const generation = ++this.renderGeneration;
    if (trees.length === 0) {
      this.primitives.removeAll();
      this.placedTreesById.clear();
      this.instancesByTreeId.clear();
      this.hoveredTreeId = null;
      this.billboardCollections.length = 0;
      return;
    }

    const fastPlaced = this.fastPlacement(trees);
    this.buildAllTiers(fastPlaced);

    const precisePlaced = await this.resolveTerrainPlacementPrecise(trees);
    if (generation !== this.renderGeneration) return;

    const changed = precisePlaced.some((p, i) => Math.abs(p.groundHeight - fastPlaced[i].groundHeight) > 0.3);
    if (changed) {
      this.logDiagnostics(precisePlaced);
      await this.buildAllTiers(precisePlaced, generation);
    }
  }

  /** Clears and rebuilds every LOD tier's primitives for the given placements; awaits tessellation readiness. */
  private async buildAllTiers(placedTrees: PlacedTree[], generation?: number): Promise<void> {
    this.primitives.removeAll();
    this.placedTreesById.clear();
    this.instancesByTreeId.clear();
    this.hoveredTreeId = null;
    this.billboardCollections.length = 0;
    for (const placed of placedTrees) {
      this.placedTreesById.set(placed.tree.id, placed);
    }

    // Every Primitive added below tessellates its geometry asynchronously
    // (on a worker) — added here so render() can await all of them actually
    // becoming .ready before resolving, instead of resolving as soon as the
    // (still-invisible) primitives are merely constructed.
    const addedPrimitives: Cesium.Primitive[] = [];

    const camera = this.viewer.camera.positionWC;
    const lod0: PlacedTree[] = [];
    const lod1: PlacedTree[] = [];
    const lod2: PlacedTree[] = [];
    const lod3: PlacedTree[] = [];
    let detailedCount = 0;

    for (const placed of placedTrees) {
      const { tree, groundHeight } = placed;
      const base = Cesium.Cartesian3.fromDegrees(tree.longitude, tree.latitude, groundHeight);
      const distance = Cesium.Cartesian3.distance(camera, base);
      if (distance <= LOD0_DISTANCE_M && detailedCount < MAX_DETAILED_TREES) {
        lod0.push(placed);
        detailedCount++;
      } else if (distance <= LOD1_DISTANCE_M && detailedCount < MAX_DETAILED_TREES) {
        lod1.push(placed);
        detailedCount++;
      } else if (distance <= LOD2_DISTANCE_M) {
        lod2.push(placed);
      } else if (distance <= LOD3_DISTANCE_M) {
        lod3.push(placed);
      }
      // Beyond LOD3_DISTANCE_M: not built at all (LOD4/hidden).
    }

    this.buildGeometryTier(lod0, "fine", [0, LOD0_DISTANCE_M], true, addedPrimitives);
    this.buildGeometryTier(lod1, "medium", [0, LOD1_DISTANCE_M], true, addedPrimitives);
    this.buildGeometryTier(lod2, "coarse", [0, LOD2_DISTANCE_M], false, addedPrimitives);
    this.buildBillboardTier(lod3);

    if (addedPrimitives.length) {
      await Promise.all(addedPrimitives.map((primitive) => waitUntilPrimitiveReady(primitive)));
      if (generation !== undefined && generation !== this.renderGeneration) return;
    }
  }

  private buildGeometryTier(
    placedTrees: PlacedTree[],
    tessellation: Tessellation,
    distanceDisplayConditionM: [number, number],
    withTrunk: boolean,
    addedPrimitives: Cesium.Primitive[]
  ): void {
    if (placedTrees.length === 0) return;

    const trunks: Cesium.GeometryInstance[] = [];
    const crowns: Cesium.GeometryInstance[] = [];
    // tree.id -> instance ids contributed by this tier, resolved to
    // TreeInstanceRef entries once we know which Primitive holds them.
    const treeToInstanceIds = new Map<string, string[]>();

    for (const { tree, groundHeight, treeHeight } of placedTrees) {
      const canopyRadius = tree.crownRadius ?? treeHeight * 0.22;
      const crownInstances = buildCrownInstances({
        tree,
        groundHeight,
        treeHeight,
        canopyRadius,
        tessellation,
        distanceDisplayConditionM,
      });
      crowns.push(...crownInstances);
      const ids = crownInstances.map((instance) => String(instance.id));
      if (withTrunk) {
        const trunkInstance = buildTrunkInstance(
          tree,
          groundHeight,
          treeHeight,
          canopyRadius,
          tessellation,
          distanceDisplayConditionM
        );
        trunks.push(trunkInstance);
        ids.push(String(trunkInstance.id));
      }
      treeToInstanceIds.set(tree.id, ids);
    }

    let trunksPrimitive: Cesium.Primitive | undefined;
    if (trunks.length) {
      trunksPrimitive = new Cesium.Primitive({
        geometryInstances: trunks,
        // flat: false enables Cesium's built-in per-fragment Phong shading
        // (uses the geometry's real normals + the scene's light direction)
        // instead of one uniform flat color per triangle — this is what
        // gives the trunk visible cylindrical shading/roundness instead of
        // reading as a flat-shaded prism, using only a standard Appearance
        // option, no custom shader code.
        appearance: new Cesium.PerInstanceColorAppearance({
          translucent: false,
          closed: true,
          flat: false,
        }),
        // A Primitive's shadow mode defaults to DISABLED — without this,
        // trees never cast (or receive) shadows regardless of the scene's
        // shadow map being enabled, which is why real sun-driven tree
        // shadows weren't appearing on the ground even with the cinematic
        // effect on.
        shadows: Cesium.ShadowMode.ENABLED,
      });
      this.primitives.add(trunksPrimitive);
      addedPrimitives.push(trunksPrimitive);
    }

    let crownsPrimitive: Cesium.Primitive | undefined;
    if (crowns.length) {
      crownsPrimitive = new Cesium.Primitive({
        geometryInstances: crowns,
        appearance: new Cesium.PerInstanceColorAppearance({
          // Cesium cannot cast shadows from translucent geometry — full
          // stop, not a tunable setting — so the canopy has to render
          // opaque to cast a real tree-shaped shadow onto the ground. The
          // per-instance color still carries its jittered species tone;
          // this only changes the blend mode, so the visible trade is
          // canopies read as solid spheres instead of softly see-through.
          translucent: false,
          closed: true,
          // Same Phong shading as the trunk — rounded-looking canopy
          // shading (soft normals/highlight falloff) instead of flat
          // uniform-color lobes.
          flat: false,
        }),
        shadows: Cesium.ShadowMode.ENABLED,
      });
      this.primitives.add(crownsPrimitive);
      addedPrimitives.push(crownsPrimitive);
    }

    for (const [treeId, instanceIds] of treeToInstanceIds) {
      const refs: TreeInstanceRef[] = [];
      for (const instanceId of instanceIds) {
        const isTrunk = instanceId.startsWith("trunk-");
        const primitive = isTrunk ? trunksPrimitive : crownsPrimitive;
        if (!primitive) continue;
        refs.push({ primitive, instanceId, baseColor: null });
      }
      if (refs.length) this.instancesByTreeId.set(treeId, refs);
    }
  }

  private buildBillboardTier(placedTrees: PlacedTree[]): void {
    if (placedTrees.length === 0) return;
    const collection = new Cesium.BillboardCollection();
    for (const { tree, groundHeight, treeHeight } of placedTrees) {
      const profile = resolveSpeciesProfile(tree.species, tree.label);
      collection.add({
        id: `billboard-${tree.id}`,
        position: Cesium.Cartesian3.fromDegrees(
          tree.longitude,
          tree.latitude,
          groundHeight + treeHeight * 0.5
        ),
        image: getSpeciesBillboardImage(profile, this.viewer),
        // Real-world canopy scale rather than a fixed pixel size, so a tall
        // tree's billboard doesn't read as the same size as a short one.
        width: Math.max(6, (tree.crownRadius ?? treeHeight * 0.22) * 2 * 6),
        height: Math.max(10, treeHeight * 6),
        sizeInMeters: false,
        // translucencyByDistance gives a soft fade-in near the LOD2/LOD3
        // boundary and fade-out approaching LOD3's far cutoff — a cheap,
        // fully standard Billboard property, not a custom shader — instead
        // of a hard pop at either edge.
        translucencyByDistance: new Cesium.NearFarScalar(
          LOD2_DISTANCE_M,
          0.0,
          LOD2_DISTANCE_M + 60,
          1.0
        ),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(LOD2_DISTANCE_M, LOD3_DISTANCE_M),
      });
    }
    this.primitives.add(collection);
    this.billboardCollections.push(collection);
  }

  setVisible(visible: boolean): void {
    this.primitives.show = visible;
  }

  /**
   * Tints distant (billboard-tier) trees toward the given color — pass
   * `null` to restore their real per-species image color. Unlike the
   * nearer LOD0-2 trees (which shade via Phong lighting and respond to
   * scene.light automatically), billboards are unlit sprites, so this is
   * the only way to make far trees darken at night along with everything
   * else. Cheap: only a handful of far-tree billboard collections exist at
   * once, each with at most a few hundred instances.
   */
  setNightTint(color: Cesium.Color | null): void {
    const tint = color ?? Cesium.Color.WHITE;
    for (const collection of this.billboardCollections) {
      for (let i = 0; i < collection.length; i++) {
        collection.get(i).color = tint;
      }
    }
  }

  /** Hover support: resolves a screen position to a tree id via Cesium's standard scene.pick, using the ids buildCrownInstances/buildTrunkInstance already assign. */
  pickTreeId(windowPosition: Cesium.Cartesian2): string | null {
    const picked = this.viewer.scene.pick(windowPosition);
    const id = picked?.id;
    if (typeof id !== "string") return null;
    if (id.startsWith("crown-")) {
      // crown-<treeId> or crown-<treeId>-<lobeIndex>
      const rest = id.slice("crown-".length);
      const treeId = this.placedTreesById.has(rest) ? rest : rest.replace(/-\d+$/, "");
      return this.placedTreesById.has(treeId) ? treeId : null;
    }
    if (id.startsWith("trunk-")) {
      const treeId = id.slice("trunk-".length);
      return this.placedTreesById.has(treeId) ? treeId : null;
    }
    if (id.startsWith("billboard-")) {
      const treeId = id.slice("billboard-".length);
      return this.placedTreesById.has(treeId) ? treeId : null;
    }
    return null;
  }

  /** Highlights (brightens) every geometry instance belonging to this tree; pass null to clear. No-ops cleanly for billboard-tier trees (nothing to recolor there). */
  setHoveredTree(treeId: string | null): void {
    if (this.hoveredTreeId === treeId) return;
    if (this.hoveredTreeId) this.applyHighlight(this.hoveredTreeId, false);
    this.hoveredTreeId = treeId;
    if (treeId) this.applyHighlight(treeId, true);
    // Raw per-instance geometry attribute writes (applyHighlight below)
    // aren't tracked by Cesium's own requestRenderMode change-detection —
    // unlike adding/removing/showing primitives, mutating an existing
    // instance's color attribute in place is invisible to it. Without this,
    // hovering a tree wouldn't visibly highlight until something unrelated
    // happened to trigger a render.
    this.viewer.scene.requestRender();
  }

  private applyHighlight(treeId: string, highlighted: boolean): void {
    const refs = this.instancesByTreeId.get(treeId);
    if (!refs) return;
    for (const ref of refs) {
      if (!ref.primitive.ready) continue;
      try {
        const attributes = ref.primitive.getGeometryInstanceAttributes(ref.instanceId);
        if (!ref.baseColor) {
          // ColorGeometryInstanceAttribute stores its value as a Uint8Array
          // [r,g,b,a] in [0,255], not the [0,1] float layout Cesium.Color
          // itself uses — divide down. Captured once, the first time this
          // instance is touched, so un-hovering always restores the real
          // original color rather than whatever the previous highlight
          // left behind.
          const bytes = attributes.color as unknown as Uint8Array;
          ref.baseColor = new Cesium.Color(bytes[0] / 255, bytes[1] / 255, bytes[2] / 255, bytes[3] / 255);
        }
        const target = highlighted
          ? Cesium.Color.multiplyByScalar(ref.baseColor, 1.5, new Cesium.Color())
          : ref.baseColor;
        const clamped = new Cesium.Color(
          Math.min(1, target.red),
          Math.min(1, target.green),
          Math.min(1, target.blue),
          ref.baseColor.alpha
        );
        attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(clamped, attributes.color);
      } catch {
        // Instance may belong to a Primitive still mid-(re)build (render()
        // in flight) — hover just skips it rather than throwing.
      }
    }
  }

  getTreeHoverInfo(treeId: string): TreeHoverInfo | null {
    const placed = this.placedTreesById.get(treeId);
    if (!placed) return null;
    const { tree, treeHeight } = placed;
    const profile = resolveSpeciesProfile(tree.species, tree.label);
    const imperfections = resolveImperfections(tree.id);
    const canopyWidthM = (tree.crownRadius ?? treeHeight * 0.22) * 2;
    const health: TreeHoverInfo["health"] =
      imperfections.stress < 0.2 ? "Healthy" : imperfections.stress < 0.5 ? "Stressed" : "Poor";
    const age: TreeHoverInfo["age"] =
      imperfections.maturity < 0.33 ? "Young" : imperfections.maturity < 0.7 ? "Mature" : "Old";
    return {
      treeId,
      species: tree.species ?? tree.label ?? profile.name,
      heightM: Math.round(treeHeight * 10) / 10,
      canopyWidthM: Math.round(canopyWidthM * 10) / 10,
      health,
      age,
      estimatedCarbonKgPerYear: estimateCarbonKgPerYear(treeHeight, canopyWidthM),
      source: tree.source,
    };
  }

  private toPlacedTree(tree: VegetationPoint, groundHeight: number): PlacedTree {
    const treeHeight = isValidTreeHeight(tree.treeHeight) ? tree.treeHeight : DEFAULT_TREE_HEIGHT_M;
    if (!isValidTreeHeight(tree.treeHeight)) {
      console.warn("[Tree renderer] Invalid normalized height; using explicit default", {
        id: tree.id,
        receivedHeight: tree.treeHeight,
      });
    }
    return { tree, groundHeight, treeHeight };
  }

  /**
   * Synchronous, no network wait — groundHeightCache (a real previous
   * sample) if present, else whatever globe/LiDAR elevation is already
   * loaded for the current view, else the tree's own LiDAR groundHeight.
   * Used to get trees on screen immediately; may be coarser than
   * resolveTerrainPlacementPrecise below until that resolves.
   */
  private fastPlacement(trees: VegetationPoint[]): PlacedTree[] {
    return trees.map((tree) => {
      const cached = this.groundHeightCache.get(tree.id);
      if (cached !== undefined) return this.toPlacedTree(tree, cached);
      const cartographic = Cesium.Cartographic.fromDegrees(tree.longitude, tree.latitude);
      const loadedHeight = this.viewer.scene.globe.getHeight(cartographic);
      const groundHeight =
        (Number.isFinite(loadedHeight) ? loadedHeight : undefined) ??
        (Number.isFinite(tree.groundHeight) ? tree.groundHeight : undefined) ??
        0;
      return this.toPlacedTree(tree, groundHeight);
    });
  }

  /** Precise, most-detailed terrain heights — slow/network-dependent. Only samples trees missing from groundHeightCache; populates it for future calls. */
  private async resolveTerrainPlacementPrecise(
    trees: VegetationPoint[]
  ): Promise<PlacedTree[]> {
    const uncached = trees.filter((tree) => !this.groundHeightCache.has(tree.id));

    if (uncached.length > 0) {
      const cartographics = uncached.map((tree) =>
        Cesium.Cartographic.fromDegrees(tree.longitude, tree.latitude)
      );
      let sampled: Cesium.Cartographic[] = [];
      try {
        sampled = await Cesium.sampleTerrainMostDetailed(
          this.viewer.terrainProvider,
          cartographics
        );
      } catch (error) {
        console.warn(
          "[Tree placement] Most-detailed terrain sampling failed; using loaded globe/LiDAR elevations",
          error
        );
      }

      uncached.forEach((tree, index) => {
        const sampledHeight = sampled[index]?.height;
        const loadedHeight = this.viewer.scene.globe.getHeight(cartographics[index]);
        const groundHeight =
          (Number.isFinite(sampledHeight) ? sampledHeight : undefined) ??
          (Number.isFinite(loadedHeight) ? loadedHeight : undefined) ??
          (Number.isFinite(tree.groundHeight) ? tree.groundHeight : undefined) ??
          0;
        if (
          tree.groundHeight !== undefined &&
          Number.isFinite(sampledHeight) &&
          Math.abs(tree.groundHeight - sampledHeight) > 3
        ) {
          console.warn("[Tree placement] LiDAR DTM and Cesium terrain differ by >3 m", {
            id: tree.id,
            lidarGroundM: tree.groundHeight,
            terrainGroundM: sampledHeight,
          });
        }
        if (
          !Number.isFinite(sampledHeight) &&
          !Number.isFinite(loadedHeight) &&
          !Number.isFinite(tree.groundHeight)
        ) {
          console.warn("[Tree placement] Missing ground elevation; using 0 m", {
            id: tree.id,
            latitude: tree.latitude,
            longitude: tree.longitude,
          });
        }
        this.groundHeightCache.set(tree.id, groundHeight);
      });
    }

    return trees.map((tree) => this.toPlacedTree(tree, this.groundHeightCache.get(tree.id) ?? 0));
  }

  private logDiagnostics(placedTrees: PlacedTree[]): void {
    console.table(
      placedTrees.slice(0, 20).map(({ tree, groundHeight, treeHeight }) => ({
        treeId: tree.id,
        latitude: Number(tree.latitude.toFixed(7)),
        longitude: Number(tree.longitude.toFixed(7)),
        groundElevationM: Number(groundHeight.toFixed(2)),
        treeHeightM: Number(treeHeight.toFixed(2)),
        heightSource: tree.heightSource ?? "Default",
      }))
    );
    const counts = { LiDAR: 0, Measured: 0, Estimated: 0, Default: 0 };
    placedTrees.forEach(({ tree }) => {
      counts[tree.heightSource ?? "Default"]++;
    });
    console.info("[Tree height] Cesium placement report", {
      totalTreesLoaded: placedTrees.length,
      treesWithRealHeights: counts.LiDAR,
      treesWithMeasuredHeights: counts.Measured,
      treesWithEstimatedHeights: counts.Estimated,
      treesUsingDefaultHeight: counts.Default,
      invalidAfterNormalization: placedTrees.filter(
        ({ tree }) => !isValidTreeHeight(tree.treeHeight)
      ).length,
      placementVerification:
        "Trunk base = sampled terrain elevation; crown top = base + treeHeight",
    });
  }

  destroy(): void {
    this.renderGeneration++;
    if (!this.primitives.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.primitives);
    }
  }
}
