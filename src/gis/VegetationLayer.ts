import * as Cesium from "cesium";
import {
  VegetationFeature,
  VegetationPoint,
  VegetationSummary,
} from "../services/vegetation";
import { TreeRenderer } from "./TreeRenderer";

/** Safety cap so awaiting canopy readiness can never hang forever if its worker-side tessellation stalls. */
const CANOPY_READY_TIMEOUT_MS = 8000;

function waitUntilPrimitiveReady(
  primitive: { ready: boolean },
  timeoutMs = CANOPY_READY_TIMEOUT_MS
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

export class VegetationLayer {
  private readonly root = new Cesium.PrimitiveCollection();
  private readonly trees: TreeRenderer;
  private canopyPrimitive: Cesium.GroundPrimitive | null = null;
  // Desired canopy-polygon visibility, remembered independently of whether
  // the primitive currently exists. setCanopyVisible can only reach a
  // primitive that has already been built, but setData replaces that
  // primitive on every data change — and a newly-constructed
  // GroundPrimitive defaults to show = true. Without keeping the intent
  // here, a "hide" applied before the first setData (which is exactly what
  // happens when the toggle's initial value is false) was silently
  // discarded the moment the polygons were rebuilt.
  private canopyVisible = true;
  private entityIds: string[] = [];
  // Debug-only layer for the "Tree Centers" toggle — off by default, and
  // distinct from the removed production far-LOD dots (see TreeRenderer.ts).
  private readonly treeCenters = new Cesium.PointPrimitiveCollection();
  private lastTreeFeatures: VegetationPoint[] = [];
  private treeCentersVisible = false;
  // Guards against doing the (expensive: terrain sampling + async geometry
  // tessellation) work in setData() twice for the same data — App.tsx's
  // "Analyse GVI" flow calls this directly and awaits it (to know for
  // certain trees have actually finished rendering before capturing a
  // screenshot), while the reactive `summary` prop effect elsewhere also
  // calls setData with that same object on every render.
  private lastAppliedSummary: VegetationSummary | null = null;

  /** Removes the camera.moveEnd listener that drives LOD re-tiering. */
  private readonly detachLodRefresh: () => void;

  constructor(private readonly viewer: Cesium.Viewer) {
    viewer.scene.groundPrimitives.add(this.root);
    this.trees = new TreeRenderer(viewer);
    viewer.scene.primitives.add(this.treeCenters);

    // Re-tier tree geometry once the camera settles somewhere new — see
    // TreeRenderer.refreshLodForCamera for why a one-time bucketing at
    // render() time isn't enough. moveEnd (not the per-frame changed event)
    // means this runs once per navigation, not continuously during a
    // flight, and refreshLodForCamera itself no-ops unless the camera
    // actually travelled far enough to change any tree's tier.
    const onMoveEnd = () => {
      void this.trees.refreshLodForCamera();
    };
    viewer.camera.moveEnd.addEventListener(onMoveEnd);
    this.detachLodRefresh = () => viewer.camera.moveEnd.removeEventListener(onMoveEnd);
  }

  /**
   * Resolves once every tree/canopy primitive for this data is actually
   * `.ready` (visible), not just constructed — callers that need to
   * screenshot the result (GVI capture) MUST await this; capturing right
   * after calling this used to be able to catch trees mid-tessellation,
   * i.e. invisible, which is what caused GVI scores to come out false/low.
   */
  async setData(summary: VegetationSummary | null): Promise<void> {
    if (summary === this.lastAppliedSummary) return;
    this.lastAppliedSummary = summary;

    this.root.removeAll();
    this.canopyPrimitive = null;
    this.entityIds.forEach((id) => this.viewer.entities.removeById(id));
    this.entityIds = [];
    if (!summary) {
      this.trees.render([]);
      this.lastTreeFeatures = [];
      this.rebuildTreeCenters();
      return;
    }
    const treeFeatures = summary.features.filter(
      (feature): feature is VegetationPoint =>
        feature.kind === "point" &&
        (feature.category === "tree" || feature.category === "street_tree")
    );
    this.lastTreeFeatures = treeFeatures;
    this.rebuildTreeCenters();
    const treesRendered = this.trees.render(treeFeatures);

    // Every tree now carries a canopy polygon from services/canopy.ts (real
    // LiDAR crown, or a circle/ellipse derived from measured/estimated
    // crown data) — draw it for all trees, not just the LiDAR subset. This
    // is a flat, ground-draped shape (used for GVI canopy-visibility
    // analysis, not primarily for looking good) — with no distance limit,
    // it stayed visible at every zoom level, and from an oblique angle far
    // out a thin flat ground polygon reads as a bright green streak/
    // "footprint" rather than a tree, competing with (and at distance,
    // replacing the visual impression of) TreeRenderer's actual 3D
    // LOD0-3 tree geometry/billboards. Capped to the same near range as
    // TreeRenderer's LOD0/LOD1 "detailed" tier (see LOD0_DISTANCE_M/
    // LOD1_DISTANCE_M in TreeRenderer.ts) so beyond that, only the 3D
    // tree shapes represent trees.
    const CANOPY_POLYGON_MAX_DISTANCE_M = 300;
    const canopyInstances = treeFeatures.flatMap((tree) => {
      if (!tree.canopyPolygon || tree.canopyPolygon.length < 3) return [];
      return [
        new Cesium.GeometryInstance({
          id: tree.id,
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(
              tree.canopyPolygon.map((point) =>
                Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude)
              )
            ),
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.FORESTGREEN.withAlpha(0.5)
            ),
            distanceDisplayCondition: new Cesium.DistanceDisplayConditionGeometryInstanceAttribute(
              0,
              CANOPY_POLYGON_MAX_DISTANCE_M
            ),
          },
        }),
      ];
    });
    // Tessellating a GroundPrimitive per tree is genuinely expensive, and
    // setData is awaited by the GVI capture flow — so when the layer is
    // hidden there is no reason to pay for geometry nobody will see.
    // setCanopyVisible(true) rebuilds it if it is ever switched back on.
    if (canopyInstances.length && this.canopyVisible) {
      this.canopyPrimitive = new Cesium.GroundPrimitive({
        geometryInstances: canopyInstances,
        appearance: new Cesium.PerInstanceColorAppearance({
          translucent: true,
          flat: true,
        }),
        asynchronous: true,
        // Carries the current toggle state onto the replacement primitive —
        // see the canopyVisible field for why this can't be left to default.
        show: this.canopyVisible,
      });
      this.root.add(this.canopyPrimitive);
    }
    const treeIds = new Set(treeFeatures.map((tree) => tree.id));
    summary.features
      .filter((feature) => !treeIds.has(feature.id))
      .forEach((feature) => this.addLandcover(feature));

    await Promise.all([
      treesRendered,
      this.canopyPrimitive ? waitUntilPrimitiveReady(this.canopyPrimitive) : Promise.resolve(),
    ]);
  }

  setObstructed(ids: Set<string> | undefined): void {
    if (!this.canopyPrimitive?.ready) return;
    for (const treeId of ids ?? []) {
      try {
        const attributes = this.canopyPrimitive.getGeometryInstanceAttributes(treeId);
        attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
          Cesium.Color.GRAY.withAlpha(0.3),
          attributes.color
        );
      } catch {
        // The id may refer to a fallback tree represented only by a point.
      }
    }
  }

  /**
   * Debug toggles for "Visible Canopy" / "Occluded Canopy": recolors each
   * tree's ground canopy polygon by the per-tree visibleFraction from the
   * last computeCanopyGVI run (services/gviCanopy.ts). GroundPrimitive
   * geometry instances only support per-instance color, not per-instance
   * show, so "hide this category" is implemented as alpha 0 rather than
   * true removal — same technique setObstructed already uses above.
   */
  setCanopyVisibilityColoring(
    perTreeResult: Map<string, { visibleFraction: number }> | null,
    showVisible: boolean,
    showOccluded: boolean
  ): void {
    if (!this.canopyPrimitive?.ready) return;
    for (const tree of this.lastTreeFeatures) {
      const result = perTreeResult?.get(tree.id);
      if (!result) continue;
      const isVisible = result.visibleFraction > 0;
      const show = isVisible ? showVisible : showOccluded;
      const color = !show
        ? Cesium.Color.TRANSPARENT
        : isVisible
        ? Cesium.Color.FORESTGREEN.withAlpha(0.5)
        : Cesium.Color.GRAY.withAlpha(0.35);
      try {
        const attributes = this.canopyPrimitive.getGeometryInstanceAttributes(tree.id);
        attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(color, attributes.color);
      } catch {
        // The id may refer to a tree whose canopy polygon didn't render.
      }
    }
  }

  /** Debug toggle: shows/hides a lightweight point marker at each tree's trunk location. */
  setTreeCentersVisible(visible: boolean): void {
    this.treeCentersVisible = visible;
    this.rebuildTreeCenters();
  }

  private rebuildTreeCenters(): void {
    this.treeCenters.removeAll();
    if (!this.treeCentersVisible) return;
    for (const tree of this.lastTreeFeatures) {
      this.treeCenters.add({
        id: `center-${tree.id}`,
        position: Cesium.Cartesian3.fromDegrees(
          tree.longitude,
          tree.latitude,
          tree.groundHeight ?? 0
        ),
        pixelSize: 4,
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
      });
    }
  }

  setVisible(visible: boolean): void {
    this.root.show = visible;
    this.trees.setVisible(visible);
    this.entityIds.forEach((id) => {
      const entity = this.viewer.entities.getById(id);
      if (entity) entity.show = visible;
    });
  }

  /** Debug toggle: shows/hides only the ground canopy polygons (Canopy Polygons). */
  setCanopyVisible(visible: boolean): void {
    const wasVisible = this.canopyVisible;
    this.canopyVisible = visible;
    if (this.canopyPrimitive) {
      this.canopyPrimitive.show = visible;
      return;
    }
    // No primitive to show because setData skipped building it while
    // hidden. Rebuild from the retained summary so switching the toggle
    // back on still works rather than silently doing nothing — the
    // idempotency guard has to be cleared first, or setData would treat
    // this as the same data it already applied and return immediately.
    if (visible && !wasVisible && this.lastAppliedSummary) {
      const summary = this.lastAppliedSummary;
      this.lastAppliedSummary = null;
      void this.setData(summary);
    }
  }

  /** Debug toggle: shows/hides only the procedural 3D tree geometry (3D Trees). */
  setTreesVisible(visible: boolean): void {
    this.trees.setVisible(visible);
  }

  /** Passthrough to TreeRenderer — see its own docs for why only the far billboard tier needs explicit tinting. */
  setTreeNightTint(color: Cesium.Color | null): void {
    this.trees.setNightTint(color);
  }

  /** Hover support — thin passthrough to TreeRenderer; see its own docs. */
  pickTreeId(windowPosition: Cesium.Cartesian2): string | null {
    return this.trees.pickTreeId(windowPosition);
  }

  setHoveredTree(treeId: string | null): void {
    this.trees.setHoveredTree(treeId);
  }

  getTreeHoverInfo(treeId: string) {
    return this.trees.getTreeHoverInfo(treeId);
  }

  private addLandcover(feature: VegetationFeature): void {
    const color = Cesium.Color.fromCssColorString(feature.color);
    const isVegetatedArea =
      feature.category === "forest" ||
      feature.category === "wood" ||
      feature.category === "grassland" ||
      feature.category === "scrub";
    const isCanopyArea =
      feature.category === "forest" || feature.category === "wood";
    const entity =
      feature.kind === "polygon"
        ? this.viewer.entities.add({
            id: `veg-${feature.id}`,
            name: feature.label ?? feature.category,
            polygon: {
              hierarchy: feature.positions.map((point) =>
                Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude)
              ),
              // A park property is not uniformly vegetation. Only explicitly
              // vegetated land-cover geometry is drawn, preventing a park
              // boundary from covering roads, water, and buildings.
              fill: isVegetatedArea,
              material: color.withAlpha(0.28),
              outline: isVegetatedArea,
              outlineColor: color,
              height: isCanopyArea ? 8 : 0,
              heightReference: isCanopyArea
                ? Cesium.HeightReference.RELATIVE_TO_GROUND
                : Cesium.HeightReference.CLAMP_TO_GROUND,
            },
          })
        : this.viewer.entities.add({
            id: `veg-${feature.id}`,
            position: Cesium.Cartesian3.fromDegrees(feature.longitude, feature.latitude),
            ellipse: {
              semiMajorAxis: feature.crownRadius ?? 3.5,
              semiMinorAxis: feature.crownRadius ?? 3.5,
              material: color.withAlpha(0.55),
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            },
          });
    this.entityIds.push(entity.id);
  }

  /**
   * Rebuilds tree geometry for the camera's current position and resolves
   * once it is actually visible. The moveEnd listener in the constructor
   * already does this automatically after ordinary navigation; callers use
   * this when they must *await* the result — notably the GVI capture path,
   * which cannot screenshot a scene whose trees are still tiered for a
   * previous viewpoint.
   */
  async refreshTreeLod(): Promise<void> {
    await this.trees.refreshLodForCamera();
  }

  destroy(): void {
    this.detachLodRefresh();
    this.entityIds.forEach((id) => this.viewer.entities.removeById(id));
    this.trees.destroy();
    if (!this.root.isDestroyed()) {
      this.viewer.scene.groundPrimitives.remove(this.root);
    }
    if (!this.treeCenters.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.treeCenters);
    }
  }
}
