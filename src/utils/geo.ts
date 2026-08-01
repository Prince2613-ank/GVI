// Geographic math helpers shared across services and hooks.

const EARTH_RADIUS_M = 6378137;

/** Haversine distance in meters between two lat/lon points. */
export function haversineDistanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/** Offsets a lat/lon point by a local ENU displacement (meters). */
export function offsetLatLon(
  latitude: number,
  longitude: number,
  eastM: number,
  northM: number
): { latitude: number; longitude: number } {
  const dLat = (northM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon =
    (eastM / (EARTH_RADIUS_M * Math.cos((Math.PI * latitude) / 180))) *
    (180 / Math.PI);
  return {
    latitude: latitude + dLat,
    longitude: longitude + dLon,
  };
}

export interface LatLonBoundingBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Computes a lat/lon bounding box that fully contains a circle of the given
 * radius (meters) around a point. Used by data sources (e.g. Socrata) whose
 * datasets lack a point-typed geometry column and so can't be queried with
 * a native circle/radius filter.
 */
export function boundingBoxForRadius(
  latitude: number,
  longitude: number,
  radiusM: number
): LatLonBoundingBox {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLon =
    (radiusM / (EARTH_RADIUS_M * Math.cos((Math.PI * latitude) / 180))) *
    (180 / Math.PI);
  return {
    minLat: latitude - dLat,
    maxLat: latitude + dLat,
    minLon: longitude - dLon,
    maxLon: longitude + dLon,
  };
}

/**
 * Compass bearing (degrees, clockwise from north) from one point to
 * another, using a flat local-plane approximation — accurate enough at the
 * few-hundred-meter scale this app operates at (vegetation search radius,
 * facing-cone filtering), without the cost of full geodesic math.
 */
export function bearingDeg(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number
): number {
  const metersPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const metersPerDegLon = metersPerDegLat * Math.cos((fromLat * Math.PI) / 180);
  const north = (toLat - fromLat) * metersPerDegLat;
  const east = (toLon - fromLon) * metersPerDegLon;
  const deg = (Math.atan2(east, north) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * Inverse of offsetLatLon: the local ENU displacement (meters) from an
 * origin point to a target lat/lon, using the same flat-plane approximation
 * as bearingDeg — accurate enough for buffering a few-hundred-meter street
 * segment into a corridor polygon, without full geodesic math.
 */
export function latLonToLocalMeters(
  originLat: number,
  originLon: number,
  lat: number,
  lon: number
): { eastM: number; northM: number } {
  const metersPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const metersPerDegLon = metersPerDegLat * Math.cos((originLat * Math.PI) / 180);
  return {
    eastM: (lon - originLon) * metersPerDegLon,
    northM: (lat - originLat) * metersPerDegLat,
  };
}

/** Converts a compass heading in degrees to radians. */
export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}
