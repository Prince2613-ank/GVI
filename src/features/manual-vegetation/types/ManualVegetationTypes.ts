export interface LonLat {
  longitude: number;
  latitude: number;
}

/** In-memory, editor-friendly shape — positions in drawing order, ring not closed. */
export interface ManualVegetationPolygon {
  id: string;
  name: string;
  positions: LonLat[];
  createdAt: number;
  updatedAt: number;
  areaM2: number;
  centroid: LonLat;
}

export interface ManualVegetationFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Polygon";
    /** [ [ [lon, lat], ... ring, first point repeated last ] ] — standard GeoJSON polygon. */
    coordinates: number[][][];
  };
  properties: {
    type: "manual_vegetation";
    name: string;
    source: "manual";
    confidence: number;
    createdAt: number;
    updatedAt: number;
    areaM2: number;
  };
}

export interface ManualVegetationCollection {
  type: "FeatureCollection";
  features: ManualVegetationFeature[];
}
