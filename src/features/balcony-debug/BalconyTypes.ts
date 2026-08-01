export type BalconySide = "North" | "South" | "East" | "West";

export const BALCONY_SIDES: BalconySide[] = ["North", "South", "East", "West"];
export const TOTAL_BALCONY_FLOORS = 10;
export const BALCONIES_PER_SIDE = 3;
export const TOTAL_BALCONY_VIEWPOINTS =
  TOTAL_BALCONY_FLOORS * BALCONY_SIDES.length * BALCONIES_PER_SIDE;

export interface BalconyViewpointProperties {
  id: string;
  floor: number;
  side: BalconySide;
  balcony: number;
  type: "balcony_viewpoint";
  /** Data URL screenshot of the Cesium canvas at the exact saved camera pose — shown as the gallery card thumbnail. */
  previewImage?: string;
  /** When previewImage was captured — used for "Saved Today"/etc display and sort order. */
  capturedAt?: number;
  /** Last computed GVI score (0-1) for this exact viewpoint, if the user has run an analysis for it. */
  gviScore?: number;
}

export interface BalconyViewpointFeature {
  type: "Feature";
  properties: BalconyViewpointProperties;
  geometry: {
    type: "Point";
    coordinates: [number, number, number];
  };
}

export interface BalconyViewpointCollection {
  type: "FeatureCollection";
  features: BalconyViewpointFeature[];
}

export function makeBalconyId(floor: number, side: BalconySide, balcony: number): string {
  const floorPart = String(floor).padStart(2, "0");
  const sidePart = side.charAt(0);
  const balconyPart = String(balcony).padStart(2, "0");
  return `F${floorPart}-${sidePart}-${balconyPart}`;
}
