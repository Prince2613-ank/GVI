import * as Cesium from "cesium";

/** Installs tiled terrain; source DTM GeoTIFFs remain on the processing backend. */
export async function loadTerrain(viewer: Cesium.Viewer, url?: string): Promise<void> {
  if (!url) return;
  viewer.terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(url, {
    requestVertexNormals: true,
  });
}
