// Physically-real solar position math — uses Cesium's own ephemeris
// (Simon1994PlanetaryPositions, the same VSOP87-derived model Cesium uses
// internally to light the globe) rather than a hand-rolled approximation.
//
// This module never touches `viewer.clock.currentTime` or any global scene
// state — it's pure math, independent of the render loop. The optional,
// opt-in cinematic rendering (real shadows/lighting driven by this sun
// direction) lives separately in sunlightEffects.ts, which snapshots and
// restores every viewer property it touches so it can't leak into the
// existing GVI screenshot-capture pipeline (services/gvi.ts) when off.

import * as Cesium from "cesium";

export interface SunPosition {
  /** Degrees above the horizon. Negative = below horizon (night). */
  elevationDeg: number;
  /** Compass bearing the sun is in, degrees clockwise from north. */
  azimuthDeg: number;
  /** Unit vector, in ECEF, pointing from the observer toward the sun. */
  directionEcef: Cesium.Cartesian3;
}

/**
 * Computes the sun's elevation/azimuth as seen from a given lat/lon at a
 * given instant, via Cesium's real ephemeris + local ENU frame projection.
 */
export function computeSunPosition(julianDate: Cesium.JulianDate, latitude: number, longitude: number): SunPosition {
  const sunPositionInertial = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(julianDate);
  const icrfToFixed = Cesium.Transforms.computeIcrfToFixedMatrix(julianDate) ?? Cesium.Matrix3.IDENTITY;
  const sunPositionFixed = Cesium.Matrix3.multiplyByVector(icrfToFixed, sunPositionInertial, new Cesium.Cartesian3());

  const observerPosition = Cesium.Cartesian3.fromDegrees(longitude, latitude, 0);
  const enuTransform = Cesium.Transforms.eastNorthUpToFixedFrame(observerPosition);
  const inverseTransform = Cesium.Matrix4.inverseTransformation(enuTransform, new Cesium.Matrix4());

  const sunDirectionFromObserver = Cesium.Cartesian3.subtract(sunPositionFixed, observerPosition, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(sunDirectionFromObserver, sunDirectionFromObserver);
  const sunLocalEnu = Cesium.Matrix4.multiplyByPointAsVector(inverseTransform, sunDirectionFromObserver, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(sunLocalEnu, sunLocalEnu);

  const east = sunLocalEnu.x;
  const north = sunLocalEnu.y;
  const up = sunLocalEnu.z;

  const elevationDeg = Cesium.Math.toDegrees(Math.asin(Cesium.Math.clamp(up, -1, 1)));
  let azimuthDeg = Cesium.Math.toDegrees(Math.atan2(east, north));
  if (azimuthDeg < 0) azimuthDeg += 360;

  return { elevationDeg, azimuthDeg, directionEcef: sunDirectionFromObserver };
}

const BUILDING_TIME_ZONE = "America/New_York";

/**
 * Real UTC offset (ms) for a given IANA time zone at a given instant —
 * computed via Intl, not hardcoded, so it correctly tracks EST/EDT
 * transitions rather than assuming a fixed -5h/-4h offset.
 */
function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtcMs - date.getTime();
}

/**
 * Builds a JulianDate for today's calendar date *in New York* (where this
 * app's demo building actually sits — DEFAULT_LOCATION is Manhattan) at a
 * given wall-clock hour (0-24, fractional), regardless of the browser's own
 * time zone. Solar position must be computed against the building's local
 * solar time, not whatever zone the viewer's machine happens to be in.
 */
export function julianDateAtHour(hour: number): Cesium.JulianDate {
  const now = new Date();
  const offsetMs = timeZoneOffsetMs(now, BUILDING_TIME_ZONE);

  // Shift `now` by the NY offset so its UTC calendar fields read as NY's
  // wall-clock date — lets us pull today's Y/M/D as seen in New York.
  const nyWall = new Date(now.getTime() + offsetMs);
  const targetWallMs = Date.UTC(nyWall.getUTCFullYear(), nyWall.getUTCMonth(), nyWall.getUTCDate(), 0, 0, 0, 0) + hour * 3600 * 1000;

  // Convert that NY wall-clock instant back to a real UTC instant.
  const realInstantMs = targetWallMs - offsetMs;
  return Cesium.JulianDate.fromDate(new Date(realInstantMs));
}

/** The current wall-clock hour (0-24, fractional) in New York, right now. */
export function currentHourInNewYork(): number {
  const now = new Date();
  const offsetMs = timeZoneOffsetMs(now, BUILDING_TIME_ZONE);
  const nyWall = new Date(now.getTime() + offsetMs);
  return nyWall.getUTCHours() + nyWall.getUTCMinutes() / 60 + nyWall.getUTCSeconds() / 3600;
}

export interface SunriseSunset {
  sunriseHour: number | null;
  sunsetHour: number | null;
}

/**
 * Today's real sunrise/sunset for the given location — found by bisecting
 * this module's own elevation function for its horizon-crossing points
 * (the same ephemeris everything else here uses), not a lookup table or an
 * averaged/typical value. `null` means the sun doesn't cross the horizon
 * that day (polar cases) — not expected at NYC's latitude, but handled.
 */
export function findSunriseSunset(computeElevation: (hour: number) => number): SunriseSunset {
  const STEP = 0.1;
  let sunriseHour: number | null = null;
  let sunsetHour: number | null = null;

  let prevHour = 0;
  let prevElevation = computeElevation(0);
  for (let hour = STEP; hour <= 24; hour += STEP) {
    const elevation = computeElevation(hour);
    if (sunriseHour === null && prevElevation <= 0 && elevation > 0) {
      sunriseHour = bisectCrossing(prevHour, hour, computeElevation);
    }
    if (sunsetHour === null && prevElevation > 0 && elevation <= 0 && sunriseHour !== null) {
      sunsetHour = bisectCrossing(prevHour, hour, computeElevation);
    }
    prevHour = hour;
    prevElevation = elevation;
  }

  return { sunriseHour, sunsetHour };
}

function bisectCrossing(lowHour: number, highHour: number, computeElevation: (hour: number) => number): number {
  let low = lowHour;
  let high = highHour;
  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2;
    if (computeElevation(mid) > 0) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
}
