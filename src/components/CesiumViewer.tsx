import { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import { maskOsmBuildingsNearSite, useCesium } from "../hooks/useCesium";
import { BuildingTransform } from "../services/camera";
import { BUILDING_MODEL_URL } from "../utils/constants";

// The building's actual glass — materials "Solid_Glass" and "01_-_Default"
// in the GLB — used to be baked in as a near-black, half-opaque BLEND
// material (baseColorFactor ~[0.03, 0.03, 0.07], alpha ~0.5), which is why
// it rendered as a hazy dark/blue-tinted wall instead of see-through glass:
// see scripts/patch_glass_materials.mjs, which re-colored those two
// materials directly in the asset to a pale, clear tone at alpha 0.16. A
// runtime shader can't safely fix this: forcing per-fragment translucency
// via CustomShader's translucencyMode applies to the WHOLE model's single
// draw call, not just the glass fragments, and broke depth-sorting for the
// entire building. Patching the actual glTF material lets Cesium's normal
// per-primitive alpha blending handle it correctly instead.
//
// The model still has no bounce/indirect light baked in, so surfaces facing
// away from the sun — and anything seen looking OUT through a window from
// inside a room/balcony — render dim. This adds a small, deliberately subtle
// ambient-style brightness boost to every fragment to compensate (a
// stronger boost tried earlier made the whole building look flatly
// whitish/washed out, not just brighter).
const AMBIENT_BOOST_SHADER = new Cesium.CustomShader({
  fragmentShaderText: `
    void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
      material.diffuse = clamp(material.diffuse * 1.1 + vec3(0.05), 0.0, 1.0);
    }
  `,
});

// CesiumViewer owns the globe canvas and the building entity's lifecycle.
// It exposes the live Cesium.Viewer instance to its parent via onViewerReady
// so sibling components (vegetation, camera controls) can act on the scene.

interface CesiumViewerProps {
  building: BuildingTransform;
  onViewerReady: (viewer: Cesium.Viewer) => void;
  onBuildingEntityReady: (entity: Cesium.Entity) => void;
  /** Fires if Cesium.Viewer construction itself fails (e.g. WebGL context creation failing at the browser/GPU level) — see useCesium's initError. */
  onInitError?: (message: string) => void;
}

export function CesiumViewer({
  building,
  onViewerReady,
  onBuildingEntityReady,
  onInitError,
}: CesiumViewerProps) {
  const { containerRef, viewer, isReady, osmBuildingsRef, initError } = useCesium();
  const buildingEntityRef = useRef<Cesium.Entity | null>(null);

  // Notify parent once the viewer is initialized.
  useEffect(() => {
    if (viewer && isReady) {
      onViewerReady(viewer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, isReady]);

  useEffect(() => {
    if (initError) onInitError?.(initError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initError]);

  // Create the building entity once the viewer is ready.
  useEffect(() => {
    if (!viewer || !isReady || buildingEntityRef.current) return;

    const entity = viewer.entities.add({
      name: "Atlanta Corporate Office Building",
      position: Cesium.Cartesian3.fromDegrees(
        building.longitude,
        building.latitude,
        building.height
      ),
      orientation: Cesium.Transforms.headingPitchRollQuaternion(
        Cesium.Cartesian3.fromDegrees(
          building.longitude,
          building.latitude,
          building.height
        ),
        new Cesium.HeadingPitchRoll(building.rotationRad, 0, 0)
      ),
      model: {
        uri: BUILDING_MODEL_URL,
        scale: building.scale,
        customShader: AMBIENT_BOOST_SHADER,
      },
    });

    buildingEntityRef.current = entity;
    onBuildingEntityReady(entity);

    // ModelGraphics (the entity-level model API used above) has no
    // showOutline option — Cesium's ModelVisualizer always creates the
    // underlying Cesium.Model with its default showOutline: true, which
    // renders the GLB's baked CESIUM_primitive_outline edges (window
    // mullions, floor slabs, silhouette) as bright white lines, visibly
    // brighter than the building's own materials. showOutline IS a
    // runtime-settable property on the actual Model primitive though (and
    // ModelVisualizer never re-syncs it after creation), so this catches
    // that primitive via primitiveAdded — Cesium sets `model.id = entity`
    // on it — the moment the GLB finishes loading and turns outlines off.
    const outlineRemoval = viewer.scene.primitives.primitiveAdded.addEventListener(
      (primitive: unknown) => {
        if (
          primitive instanceof Cesium.Model &&
          primitive.id === entity
        ) {
          primitive.showOutline = false;
          outlineRemoval();
        }
      }
    );

    // Deliberately no viewer.zoomTo(entity) here: it resolves only once the
    // (large, slow-loading) GLB model is ready, which is often well after
    // App's own "fly to the selected window" effect has already positioned
    // the camera — zoomTo would then yank the camera away to frame the
    // entire building instead, overriding the correct window-level pose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, isReady]);

  // Keep the building entity in sync with live transform updates (STEP 3).
  useEffect(() => {
    const entity = buildingEntityRef.current;
    if (!entity || !viewer) return;

    const origin = Cesium.Cartesian3.fromDegrees(
      building.longitude,
      building.latitude,
      building.height
    );

    entity.position = new Cesium.ConstantPositionProperty(origin);
    entity.orientation = new Cesium.ConstantProperty(
      Cesium.Transforms.headingPitchRollQuaternion(
        origin,
        new Cesium.HeadingPitchRoll(building.rotationRad, 0, 0)
      )
    );

    if (entity.model) {
      entity.model.scale = new Cesium.ConstantProperty(building.scale);
    }

    // Keep the real OSM building mask centered on the model's live position
    // so the two never overlap and z-fight, no matter where it's moved to.
    if (osmBuildingsRef.current) {
      maskOsmBuildingsNearSite(
        osmBuildingsRef.current,
        building.longitude,
        building.latitude,
        building.rotationRad,
        building.scale
      );
    }
  }, [
    viewer,
    building.latitude,
    building.longitude,
    building.height,
    building.rotationRad,
    building.scale,
    osmBuildingsRef,
  ]);

  return (
    <div
      ref={containerRef}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
    />
  );
}
