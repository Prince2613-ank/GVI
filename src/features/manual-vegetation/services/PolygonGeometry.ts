import { LonLat } from "../types/ManualVegetationTypes";

const METERS_PER_DEG_LAT = 111320;

function metersPerDegLon(latitude: number): number {
  return 111320 * Math.cos((latitude * Math.PI) / 180);
}

/** Projects lon/lat ring to local planar meters (equirectangular, fine at this scale) for area/centroid math. */
function toLocalMeters(positions: LonLat[]): { x: number; y: number }[] {
  if (positions.length === 0) return [];
  const originLat = positions[0].latitude;
  const mPerLon = metersPerDegLon(originLat);
  return positions.map((p) => ({
    x: p.longitude * mPerLon,
    y: p.latitude * METERS_PER_DEG_LAT,
  }));
}

/** Shoelace formula area, in square meters. */
export function computePolygonAreaM2(positions: LonLat[]): number {
  if (positions.length < 3) return 0;
  const pts = toLocalMeters(positions);
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Plain vertex-average centroid — adequate for a debug-tool polygon, not a true area centroid. */
export function computePolygonCentroid(positions: LonLat[]): LonLat {
  if (positions.length === 0) return { longitude: 0, latitude: 0 };
  const sum = positions.reduce(
    (acc, p) => ({ longitude: acc.longitude + p.longitude, latitude: acc.latitude + p.latitude }),
    { longitude: 0, latitude: 0 }
  );
  return {
    longitude: sum.longitude / positions.length,
    latitude: sum.latitude / positions.length,
  };
}
