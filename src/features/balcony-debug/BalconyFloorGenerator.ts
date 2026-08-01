import { BalconySide, BalconyViewpointFeature, TOTAL_BALCONY_FLOORS, makeBalconyId } from "./BalconyTypes";

/**
 * Derives every other floor's viewpoint for a captured Floor 1 flat by
 * reusing its exact lon/lat and stepping the height straight up by
 * floorHeightDeltaM per floor — so only Floor 1 needs to be walked and
 * captured by hand; floors 2-10 come from "go up, same direction".
 */
export function computeUpperFloorFeature(
  floor1Feature: BalconyViewpointFeature,
  floor: number,
  floorHeightDeltaM: number
): BalconyViewpointFeature {
  const [longitude, latitude, height] = floor1Feature.geometry.coordinates;
  const { side, balcony } = floor1Feature.properties;
  return {
    type: "Feature",
    properties: {
      id: makeBalconyId(floor, side, balcony),
      floor,
      side,
      balcony,
      type: "balcony_viewpoint",
    },
    geometry: {
      type: "Point",
      coordinates: [longitude, latitude, height + floorHeightDeltaM * (floor - 1)],
    },
  };
}

/**
 * Measures the real Floor 1 -> Floor 2 height step from whatever flats have
 * both captured, per matching side/balcony, and averages them — so "one
 * floor up" uses the actual captured rise instead of a theoretical
 * FLOOR_HEIGHT_M * scale constant. Returns null if no Floor 1/Floor 2 pair
 * exists yet for any side/balcony.
 */
export function computeMeasuredFloorHeightDeltaM(features: BalconyViewpointFeature[]): number | null {
  const floor1Features = features.filter((f) => f.properties.floor === 1);
  const deltas: number[] = [];

  for (const f1 of floor1Features) {
    const f2 = features.find(
      (f) =>
        f.properties.floor === 2 &&
        f.properties.side === f1.properties.side &&
        f.properties.balcony === f1.properties.balcony
    );
    if (f2) deltas.push(f2.geometry.coordinates[2] - f1.geometry.coordinates[2]);
  }

  if (deltas.length === 0) return null;
  return deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
}

/**
 * Overwrites every floor 2-10 point's height (lon/lat left exactly as they
 * already are) with floor1Height + floorHeightDeltaM * (floor - 1), for
 * every side/balcony that has a Floor 1 point — so all 10 floors, every
 * side, end up using the exact same measured per-floor height step.
 */
export function applyUniformFloorHeightDelta(
  features: BalconyViewpointFeature[],
  floorHeightDeltaM: number
): BalconyViewpointFeature[] {
  const floor1Features = features.filter((f) => f.properties.floor === 1);
  const updated: BalconyViewpointFeature[] = [];

  for (const base of floor1Features) {
    const [longitude, latitude, baseHeight] = base.geometry.coordinates;
    for (let floor = 2; floor <= TOTAL_BALCONY_FLOORS; floor++) {
      const existing = features.find(
        (f) =>
          f.properties.floor === floor &&
          f.properties.side === base.properties.side &&
          f.properties.balcony === base.properties.balcony
      );
      const lon = existing ? existing.geometry.coordinates[0] : longitude;
      const lat = existing ? existing.geometry.coordinates[1] : latitude;
      updated.push({
        type: "Feature",
        properties: {
          id: makeBalconyId(floor, base.properties.side, base.properties.balcony),
          floor,
          side: base.properties.side,
          balcony: base.properties.balcony,
          type: "balcony_viewpoint",
        },
        geometry: {
          type: "Point",
          coordinates: [lon, lat, baseHeight + floorHeightDeltaM * (floor - 1)],
        },
      });
    }
  }
  return updated;
}

/**
 * Generates floors 2-10 for every captured Floor 1 flat. Floors that already
 * have their own saved (manually captured) point are left untouched unless
 * overwriteExisting is set.
 */
export function generateUpperFloorsFromFloor1(
  features: BalconyViewpointFeature[],
  floorHeightDeltaM: number,
  overwriteExisting = false
): BalconyViewpointFeature[] {
  const floor1Features = features.filter((f) => f.properties.floor === 1);
  const existingIds = new Set(features.map((f) => f.properties.id));
  const generated: BalconyViewpointFeature[] = [];

  for (const base of floor1Features) {
    for (let floor = 2; floor <= TOTAL_BALCONY_FLOORS; floor++) {
      const id = makeBalconyId(floor, base.properties.side, base.properties.balcony);
      if (!overwriteExisting && existingIds.has(id)) continue;
      generated.push(computeUpperFloorFeature(base, floor, floorHeightDeltaM));
    }
  }
  return generated;
}

/**
 * The single source of truth used by any "go to this flat" UI: prefer an
 * exact, manually saved point for that floor/side/balcony; otherwise derive
 * it live from that same flat's Floor 1 point (up if floor > 1). Returns
 * null only when even Floor 1 doesn't have that side/balcony captured yet.
 */
export function resolveBalconyFeature(
  features: BalconyViewpointFeature[],
  floor: number,
  side: BalconySide,
  balcony: number,
  floorHeightDeltaM: number
): { feature: BalconyViewpointFeature; isSaved: boolean } | null {
  const id = makeBalconyId(floor, side, balcony);
  const saved = features.find((f) => f.properties.id === id);
  if (saved) return { feature: saved, isSaved: true };

  if (floor === 1) return null;
  const floor1 = features.find((f) => f.properties.id === makeBalconyId(1, side, balcony));
  if (!floor1) return null;
  return { feature: computeUpperFloorFeature(floor1, floor, floorHeightDeltaM), isSaved: false };
}
