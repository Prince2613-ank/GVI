import * as Cesium from "cesium";

// semanticMask.ts supports only the legacy/debug pixel-classification GVI
// path (services/gvi.ts's classificationMode: "semantic-mask", toggled via
// GVIPanel's "Also compute legacy pixel-classification GVI" checkbox — off
// by default now that services/gviCanopy.ts is authoritative). It swaps the
// scene to a flat, high-contrast render — imagery/atmosphere/sky hidden,
// everything solid black except vegetation left visible in its own green —
// so gvi.ts's isSemanticVegetationPixel classifier (a green-channel-
// dominance check, not an HSV threshold) can pick out mapped vegetation
// geometry from an otherwise blank backdrop.

export interface SemanticVegetationScene {
  /** Restores every overridden scene property to what it was before entry. */
  restore: () => void;
}

/** Yields a couple of render frames so newly-visible/hidden geometry can draw before capture. */
export function waitForSemanticRender(viewer: Cesium.Viewer): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      viewer.scene.render();
      requestAnimationFrame(() => {
        viewer.scene.render();
        resolve();
      });
    });
  });
}

/**
 * Switches the scene into the flat black-backdrop mode described above and
 * returns a handle to restore it. Only imagery/atmosphere/sky are touched;
 * 3D building tilesets keep their real materials; the classifier tells them
 * apart from vegetation by hue/channel-dominance (buildings aren't green).
 */
export function enterSemanticVegetationScene(viewer: Cesium.Viewer): SemanticVegetationScene {
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
  };

  for (let i = 0; i < viewer.imageryLayers.length; i++) {
    const layer = viewer.imageryLayers.get(i);
    original.imageryAlphas.push({ layer, alpha: layer.alpha });
    layer.alpha = 0;
  }

  globe.baseColor = Cesium.Color.BLACK;
  globe.showGroundAtmosphere = false;
  scene.backgroundColor = Cesium.Color.BLACK;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;

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
    },
  };
}
