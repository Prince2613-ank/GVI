import * as Cesium from "cesium";

export interface GreenGreyScene {
  /** Restores every overridden scene/entity property to what it was before entry. */
  restore: () => void;
}

const GREY = Cesium.Color.fromCssColorString("#8a8a8a");

/**
 * Recolors the scene so mapped vegetation (already rendered in its own
 * green by VegetationLayer) reads clearly against a flat grey backdrop —
 * imagery/sky/atmosphere hidden, globe and the placed building tinted grey.
 * Real neighboring OSM buildings are left as-is: greying them would mean
 * overwriting the site-mask style that keeps the real building under our
 * model hidden (see useCesium.ts's maskOsmBuildingsNearSite), which isn't
 * worth re-deriving here just for this view's color scheme.
 */
export function enterGreenGreyScene(
  viewer: Cesium.Viewer,
  buildingEntity: Cesium.Entity | null
): GreenGreyScene {
  const scene = viewer.scene;
  const globe = scene.globe;

  const original = {
    baseColor: globe.baseColor.clone(),
    showGroundAtmosphere: globe.showGroundAtmosphere,
    skyBoxShow: scene.skyBox?.show,
    skyAtmosphereShow: scene.skyAtmosphere?.show,
    sunShow: scene.sun?.show,
    moonShow: scene.moon?.show,
    backgroundColor: scene.backgroundColor.clone(),
    imageryAlphas: [] as { layer: Cesium.ImageryLayer; alpha: number }[],
    modelColor: buildingEntity?.model?.color,
    modelColorBlendMode: buildingEntity?.model?.colorBlendMode,
  };

  for (let i = 0; i < viewer.imageryLayers.length; i++) {
    const layer = viewer.imageryLayers.get(i);
    original.imageryAlphas.push({ layer, alpha: layer.alpha });
    layer.alpha = 0;
  }

  globe.baseColor = GREY;
  globe.showGroundAtmosphere = false;
  scene.backgroundColor = GREY;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;

  if (buildingEntity?.model) {
    buildingEntity.model.color = new Cesium.ConstantProperty(GREY);
    buildingEntity.model.colorBlendMode = new Cesium.ConstantProperty(Cesium.ColorBlendMode.REPLACE);
  }

  return {
    restore: () => {
      globe.baseColor = original.baseColor;
      globe.showGroundAtmosphere = original.showGroundAtmosphere;
      scene.backgroundColor = original.backgroundColor;
      if (scene.skyBox && original.skyBoxShow !== undefined) {
        scene.skyBox.show = original.skyBoxShow;
      }
      if (scene.skyAtmosphere && original.skyAtmosphereShow !== undefined) {
        scene.skyAtmosphere.show = original.skyAtmosphereShow;
      }
      if (scene.sun && original.sunShow !== undefined) scene.sun.show = original.sunShow;
      if (scene.moon && original.moonShow !== undefined) scene.moon.show = original.moonShow;
      original.imageryAlphas.forEach(({ layer, alpha }) => {
        layer.alpha = alpha;
      });
      if (buildingEntity?.model) {
        buildingEntity.model.color = original.modelColor;
        buildingEntity.model.colorBlendMode = original.modelColorBlendMode;
      }
    },
  };
}
