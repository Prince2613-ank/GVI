import * as Cesium from "cesium";
import { IndoorMovementConfig } from "./IndoorMovementConfig";
import { BalconySide } from "../balcony-debug/BalconyTypes";

/**
 * The local movement volume for a single saved balcony/window viewpoint.
 * Everything here is frozen at the moment the viewpoint is entered — later
 * camera rotation (look-around) never moves `origin`/`forward`/`right`/`up`,
 * which is what keeps the clamped position pinned to the actual window
 * regardless of which way the user is currently looking.
 */
export interface IndoorZone {
  /** The saved eye position, at the locked eye height. Movement is always measured relative to this point. */
  origin: Cesium.Cartesian3;
  /** Unit, horizontal, points from the room out toward the window at the moment of entry. */
  forward: Cesium.Cartesian3;
  /** Unit, horizontal, perpendicular to `forward` — positive is to the right when facing `forward`. */
  right: Cesium.Cartesian3;
  /** Unit, local vertical (true up, not tied to camera tilt). */
  up: Cesium.Cartesian3;
  /** Meters allowed toward the window along `forward` — already tightened against the detected window plane if one was found. */
  forwardLimit: number;
  /** Meters allowed back into the room along `-forward`. */
  backLimit: number;
  /** Meters allowed along `right` in either direction. */
  sideLimit: number;
  /** Distance from origin to the detected window/glass plane along `forward`, or null if none was found within WINDOW_DETECTION_MAX_DISTANCE_M. */
  windowPlaneDistance: number | null;
}

/** Present at runtime (used internally by Cesium's own 3D Tiles picking) but not declared in this version's TS types. */
interface ScenePickFromRay {
  pickFromRay(ray: Cesium.Ray, objectsToExclude?: unknown[]): { position?: Cesium.Cartesian3 } | undefined;
}

/**
 * Projects `vector` onto the horizontal plane at `up` and normalizes it —
 * used to derive a level `forward` even when the saved camera pose had some
 * pitch, so walking never climbs or dives with the original look angle.
 */
function flattenToHorizontal(vector: Cesium.Cartesian3, up: Cesium.Cartesian3): Cesium.Cartesian3 {
  const verticalComponent = Cesium.Cartesian3.dot(vector, up);
  const vertical = Cesium.Cartesian3.multiplyByScalar(up, verticalComponent, new Cesium.Cartesian3());
  const horizontal = Cesium.Cartesian3.subtract(vector, vertical, new Cesium.Cartesian3());
  if (Cesium.Cartesian3.magnitude(horizontal) < 1e-6) {
    // The saved pose looked straight up/down — fall back to an arbitrary
    // horizontal direction so the zone still has valid, orthogonal axes
    // rather than a degenerate (near-zero) forward vector.
    return new Cesium.Cartesian3(1, 0, 0);
  }
  Cesium.Cartesian3.normalize(horizontal, horizontal);
  return horizontal;
}

/**
 * Saved balcony/window viewpoints are typically positioned right at (or
 * even fractionally past) the glass already — a ray cast starting exactly
 * on top of that surface is a classic self-intersection case, where
 * pickFromRay either misses the hit entirely or tunnels through to whatever
 * is beyond it (the street, a neighboring building), returning a false "no
 * nearby window" result. Backing the ray's start point off into the room
 * first avoids that, at the cost of not being able to detect glass literally
 * closer than this to the saved eye position (never the case in practice).
 */
const WINDOW_RAY_BACKOFF_M = 0.5;

/**
 * Casts a ray toward `forward` to find the nearest window/glass surface (or
 * any other geometry) in that direction — reuses the same scene.pickFromRay
 * approach as IndoorCollision.ts. Returns null if nothing was hit within
 * WINDOW_DETECTION_MAX_DISTANCE_M, so a viewpoint with no detectable glass
 * just falls back to the configured FORWARD_LIMIT alone.
 */
function detectWindowPlaneDistance(
  viewer: Cesium.Viewer,
  origin: Cesium.Cartesian3,
  forward: Cesium.Cartesian3
): number | null {
  try {
    const rayOrigin = Cesium.Cartesian3.subtract(
      origin,
      Cesium.Cartesian3.multiplyByScalar(forward, WINDOW_RAY_BACKOFF_M, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    const ray = new Cesium.Ray(rayOrigin, forward);
    const result = (viewer.scene as unknown as ScenePickFromRay).pickFromRay(ray, []);
    if (!result?.position) return null;
    // Measured back relative to the true origin, not the backed-off ray
    // start, so callers can treat this exactly like a direct-from-origin
    // distance (may come out negative if the hit is behind the origin,
    // which createIndoorZone's Math.max(0, ...) already guards against).
    const distanceFromRayOrigin = Cesium.Cartesian3.distance(rayOrigin, result.position);
    const distance = distanceFromRayOrigin - WINDOW_RAY_BACKOFF_M;
    if (distance > IndoorMovementConfig.WINDOW_DETECTION_MAX_DISTANCE_M) return null;
    return distance;
  } catch {
    // pickFromRay isn't supported in every context (e.g. no WebGL2/depth
    // texture support) — fail open (no detected window) rather than
    // blocking zone creation entirely.
    return null;
  }
}

/**
 * Builds the local movement zone for a viewpoint the instant it's entered.
 * Must be called while the camera is still exactly at the just-flown-to
 * pose (see IndoorCameraController.enter()) — that pose is what freezes in
 * as the zone's origin/forward/right/up.
 *
 * `side` (the balcony's facing direction, if known) selects a per-facing
 * FORWARD_LIMIT override from IndoorMovementConfig.FORWARD_LIMIT_BY_SIDE —
 * e.g. north-facing flats get a larger "maximum view" allowance, applied
 * for every floor since it's keyed only on facing, not floor number.
 */
export function createIndoorZone(viewer: Cesium.Viewer, eyeHeight: number, side?: BalconySide): IndoorZone {
  const camera = viewer.camera;
  const cartographic = Cesium.Cartographic.fromCartesian(camera.positionWC);
  cartographic.height = eyeHeight;
  const origin = Cesium.Cartographic.toCartesian(cartographic, Cesium.Ellipsoid.WGS84, new Cesium.Cartesian3());

  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const up = Cesium.Matrix4.multiplyByPointAsVector(enu, new Cesium.Cartesian3(0, 0, 1), new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(up, up);

  const forward = flattenToHorizontal(camera.directionWC, up);
  const right = Cesium.Cartesian3.cross(forward, up, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(right, right);

  const baseForwardLimit =
    (side ? IndoorMovementConfig.FORWARD_LIMIT_BY_SIDE[side] : undefined) ?? IndoorMovementConfig.FORWARD_LIMIT;

  // Still detected (for the debug overlay to draw, and for any side NOT in
  // the ignore list) even on sides that skip using it for the forward
  // limit itself — see IGNORE_WINDOW_DETECTION_FOR_SIDES.
  const windowPlaneDistance = detectWindowPlaneDistance(viewer, origin, forward);
  const ignoresWindowDetection = !!side && IndoorMovementConfig.IGNORE_WINDOW_DETECTION_FOR_SIDES.includes(side);
  const forwardLimit =
    windowPlaneDistance !== null && !ignoresWindowDetection
      ? Math.max(0, Math.min(baseForwardLimit, windowPlaneDistance - IndoorMovementConfig.WINDOW_PADDING))
      : baseForwardLimit;

  return {
    origin,
    forward,
    right,
    up,
    forwardLimit,
    backLimit: IndoorMovementConfig.BACK_LIMIT,
    sideLimit: IndoorMovementConfig.SIDE_LIMIT,
    windowPlaneDistance,
  };
}

/** Local-axis coordinates (meters from zone.origin, along zone.forward/zone.right) of a world position — the same projection the movement clamp itself uses, exposed for the debug overlay's live position readout. */
export function projectOntoZone(zone: IndoorZone, worldPosition: Cesium.Cartesian3): { forward: number; right: number } {
  const offset = Cesium.Cartesian3.subtract(worldPosition, zone.origin, new Cesium.Cartesian3());
  return {
    forward: Cesium.Cartesian3.dot(offset, zone.forward),
    right: Cesium.Cartesian3.dot(offset, zone.right),
  };
}

const DEBUG_VOLUME_COLOR = Cesium.Color.LIME.withAlpha(0.9);
const DEBUG_WINDOW_COLOR = Cesium.Color.CYAN.withAlpha(0.9);
const DEBUG_POSITION_COLOR = Cesium.Color.RED;
/** Thin "slab" thickness/height used purely so the debug boxes render as visible, roughly flat panels rather than zero-size geometry. */
const DEBUG_SLAB_THICKNESS_M = 0.05;
const DEBUG_WINDOW_HEIGHT_M = 2.2;

/**
 * Rotation matrix mapping local (right, forward, up) axes to world space —
 * used as the orientation for every debug entity so their box dimensions
 * (x = right, y = forward, z = up) line up with the zone's own axes
 * regardless of which way the building/viewpoint is rotated in the world.
 */
function zoneOrientation(zone: IndoorZone): Cesium.Quaternion {
  const rotation = new Cesium.Matrix3();
  Cesium.Matrix3.setColumn(rotation, 0, zone.right, rotation);
  Cesium.Matrix3.setColumn(rotation, 1, zone.forward, rotation);
  Cesium.Matrix3.setColumn(rotation, 2, zone.up, rotation);
  return Cesium.Quaternion.fromRotationMatrix(rotation);
}

/**
 * Draws the movement volume (green wireframe box spanning back/forward/side
 * limits), the detected window plane (cyan wireframe slab, if any), and the
 * live camera position (red point, updated every frame) for one zone.
 * Returns a cleanup function that removes everything — call it before
 * creating a new debug overlay or on indoor exit.
 */
export function showIndoorZoneDebug(viewer: Cesium.Viewer, zone: IndoorZone): () => void {
  const orientation = zoneOrientation(zone);
  const entities: Cesium.Entity[] = [];

  const volumeCenterForward = (zone.forwardLimit - zone.backLimit) / 2;
  const volumeDepth = zone.forwardLimit + zone.backLimit;
  const volumeCenter = Cesium.Cartesian3.add(
    zone.origin,
    Cesium.Cartesian3.multiplyByScalar(zone.forward, volumeCenterForward, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );
  entities.push(
    viewer.entities.add({
      name: "Indoor movement volume",
      position: volumeCenter,
      orientation,
      box: {
        dimensions: new Cesium.Cartesian3(zone.sideLimit * 2, volumeDepth, DEBUG_SLAB_THICKNESS_M),
        fill: false,
        outline: true,
        outlineColor: DEBUG_VOLUME_COLOR,
        outlineWidth: 2,
      },
    })
  );

  if (zone.windowPlaneDistance !== null) {
    const windowCenter = Cesium.Cartesian3.add(
      zone.origin,
      Cesium.Cartesian3.multiplyByScalar(zone.forward, zone.windowPlaneDistance, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    entities.push(
      viewer.entities.add({
        name: "Indoor window plane",
        position: windowCenter,
        orientation,
        box: {
          dimensions: new Cesium.Cartesian3(zone.sideLimit * 2.2, DEBUG_SLAB_THICKNESS_M, DEBUG_WINDOW_HEIGHT_M),
          fill: false,
          outline: true,
          outlineColor: DEBUG_WINDOW_COLOR,
          outlineWidth: 2,
        },
      })
    );
  }

  const positionEntity = viewer.entities.add({
    name: "Indoor camera position",
    position: Cesium.Cartesian3.clone(viewer.camera.positionWC),
    point: {
      pixelSize: 10,
      color: DEBUG_POSITION_COLOR,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 1,
    },
  });
  entities.push(positionEntity);

  const onPostRender = () => {
    positionEntity.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.clone(viewer.camera.positionWC));
  };
  viewer.scene.postRender.addEventListener(onPostRender);

  return () => {
    viewer.scene.postRender.removeEventListener(onPostRender);
    entities.forEach((entity) => viewer.entities.remove(entity));
  };
}
