import * as Cesium from "cesium";

interface BuildingFeatureCollection {
  features: Array<{
    id?: string;
    geometry: { type: "Polygon"; coordinates: number[][][] };
    properties: {
      id: string;
      height: number;
      roofElevation: number;
      groundElevation?: number;
    };
  }>;
}

/** Loads LiDAR-height footprints and extrudes them above their measured DTM base. */
export class BuildingLayer {
  private entityIds: string[] = [];

  constructor(private readonly viewer: Cesium.Viewer) {}

  async load(url: string, signal?: AbortSignal): Promise<void> {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Building LiDAR API returned ${response.status}`);
    const data = (await response.json()) as BuildingFeatureCollection;
    this.clear();
    for (const feature of data.features) {
      const ground = feature.properties.groundElevation ?? 0;
      const entity = this.viewer.entities.add({
        id: `lidar-building-${feature.properties.id ?? feature.id}`,
        polygon: {
          hierarchy: feature.geometry.coordinates[0].map(([longitude, latitude]) =>
            Cesium.Cartesian3.fromDegrees(longitude, latitude)
          ),
          height: ground,
          extrudedHeight: ground + feature.properties.height,
          material: Cesium.Color.WHITE,
          outline: false,
        },
      });
      this.entityIds.push(entity.id);
    }
  }

  clear(): void {
    this.entityIds.forEach((id) => this.viewer.entities.removeById(id));
    this.entityIds = [];
  }
}
