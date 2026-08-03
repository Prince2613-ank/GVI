import * as Cesium from "cesium";
import { IndoorCameraConfig } from "./IndoorCameraConfig";
import { IndoorMovementConfig } from "./IndoorMovementConfig";
import { IndoorZone } from "./IndoorZone";
import { clampMovementDistance } from "./IndoorCollision";
import { indoorState } from "./IndoorState";

/**
 * Flattens a world-space vector onto the local horizontal (east-north)
 * plane at `cameraPosition` — looking up/down (or strafing while tilted)
 * must never make the camera climb or dive, only rotating the view does
 * that (this is what "lock camera height" means for an FPS-style
 * walkthrough: forward/back/strafe movement is always level with the floor).
 * Only used as a fallback when no zone is active (see computeMoveDelta) —
 * normally the zone's own frozen forward/right axes are used instead.
 */
function flattenHorizontal(cameraPosition: Cesium.Cartesian3, worldVector: Cesium.Cartesian3): Cesium.Cartesian3 {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(cameraPosition);
  const inverse = Cesium.Matrix4.inverseTransformation(enu, new Cesium.Matrix4());
  const local = Cesium.Matrix4.multiplyByPointAsVector(inverse, worldVector, new Cesium.Cartesian3());
  local.z = 0;
  if (Cesium.Cartesian3.magnitude(local) < 1e-6) {
    return Cesium.Cartesian3.clone(worldVector);
  }
  Cesium.Cartesian3.normalize(local, local);
  return Cesium.Matrix4.multiplyByPointAsVector(enu, local, new Cesium.Cartesian3());
}

/**
 * Combines held forward/strafe input (each -1/0/1) into a normalized
 * world-space direction using a FIXED pair of axes — either the current
 * viewpoint's zone.forward/zone.right (the normal case: pressing "forward"
 * always walks toward the window, however you've turned to look), or, if no
 * zone is active, the live camera direction as a fallback (old FPS-style
 * curve-with-view behavior).
 */
function computeMoveDirection(
  forwardAxis: Cesium.Cartesian3,
  rightAxis: Cesium.Cartesian3,
  forwardInput: number,
  strafeInput: number,
  fallback: Cesium.Cartesian3 | null
): Cesium.Cartesian3 | null {
  if (forwardInput === 0 && strafeInput === 0) {
    return fallback;
  }

  const combined = Cesium.Cartesian3.add(
    Cesium.Cartesian3.multiplyByScalar(forwardAxis, forwardInput, new Cesium.Cartesian3()),
    Cesium.Cartesian3.multiplyByScalar(rightAxis, strafeInput, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

  if (Cesium.Cartesian3.magnitude(combined) < 1e-6) return fallback;
  Cesium.Cartesian3.normalize(combined, combined);
  return combined;
}

function moveToward(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) return target;
  return current + Math.sign(target - current) * maxDelta;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Scales a proposed movement delta along one local axis down as the CURRENT
 * position on that axis nears its limit — full speed while more than
 * SOFT_ZONE meters from the limit, ramping linearly to zero right at it.
 * Only dampens the direction actually heading toward the limit; moving away
 * from a limit is never slowed by it.
 */
function applySoftBoundary(
  currentValue: number,
  delta: number,
  positiveLimit: number,
  negativeLimit: number
): number {
  const softZone = IndoorMovementConfig.SOFT_ZONE;
  if (delta > 0) {
    const remaining = positiveLimit - currentValue;
    if (remaining <= 0) return 0;
    return remaining >= softZone ? delta : delta * (remaining / softZone);
  }
  if (delta < 0) {
    const remaining = currentValue - negativeLimit;
    if (remaining <= 0) return 0;
    return remaining >= softZone ? delta : delta * (remaining / softZone);
  }
  return delta;
}

/**
 * Computes the next camera position for one frame of continuous movement,
 * given the requested (unclamped) distance to travel along `direction`.
 * When a zone is active, the candidate position is expressed in the zone's
 * local forward/right coordinates, soft-damped near each limit (see
 * applySoftBoundary), then hard-clamped to the zone's forward/back/side
 * limits as a backstop — this is what keeps the user pinned near the
 * selected window/balcony no matter how long they hold a movement key.
 * `clampMovementDistance` (general wall/furniture raycast collision) is
 * still applied on top, since the zone's box alone doesn't know about
 * interior geometry within its bounds.
 */
function computeZoneClampedTarget(
  scene: Cesium.Scene,
  origin: Cesium.Cartesian3,
  direction: Cesium.Cartesian3,
  distance: number,
  zone: IndoorZone
): Cesium.Cartesian3 {
  const rawDelta = Cesium.Cartesian3.multiplyByScalar(direction, distance, new Cesium.Cartesian3());
  const forwardDelta = Cesium.Cartesian3.dot(rawDelta, zone.forward);
  const rightDelta = Cesium.Cartesian3.dot(rawDelta, zone.right);

  const offset = Cesium.Cartesian3.subtract(origin, zone.origin, new Cesium.Cartesian3());
  const currentForward = Cesium.Cartesian3.dot(offset, zone.forward);
  const currentRight = Cesium.Cartesian3.dot(offset, zone.right);

  const dampedForwardDelta = applySoftBoundary(currentForward, forwardDelta, zone.forwardLimit, -zone.backLimit);
  const dampedRightDelta = applySoftBoundary(currentRight, rightDelta, zone.sideLimit, -zone.sideLimit);

  const clampedForward = clampNumber(currentForward + dampedForwardDelta, -zone.backLimit, zone.forwardLimit);
  const clampedRight = clampNumber(currentRight + dampedRightDelta, -zone.sideLimit, zone.sideLimit);

  const zoneTarget = Cesium.Cartesian3.add(
    zone.origin,
    Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(zone.forward, clampedForward, new Cesium.Cartesian3()),
      Cesium.Cartesian3.multiplyByScalar(zone.right, clampedRight, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    ),
    new Cesium.Cartesian3()
  );

  const moveVector = Cesium.Cartesian3.subtract(zoneTarget, origin, new Cesium.Cartesian3());
  const moveDistance = Cesium.Cartesian3.magnitude(moveVector);
  if (moveDistance < 1e-6) return origin;

  const moveDirection = Cesium.Cartesian3.normalize(moveVector, new Cesium.Cartesian3());
  const allowed = clampMovementDistance(scene, origin, moveDirection, moveDistance);
  if (allowed <= 1e-6) return origin;
  if (allowed >= moveDistance) return zoneTarget;
  return Cesium.Cartesian3.add(
    origin,
    Cesium.Cartesian3.multiplyByScalar(moveDirection, allowed, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );
}

// ---- Continuous velocity-based movement state (forward/back + strafe) ----
// Exactly one rAF loop runs at a time, regardless of how many of
// forward/backward/left/right are currently held — it reads the live input
// state every frame rather than being re-created per key/button.

let movementViewer: Cesium.Viewer | null = null;
let forwardInput = 0; // -1, 0, or 1 — held-input state, not velocity
let strafeInput = 0; // -1, 0, or 1
let currentSpeed = 0; // m/s, ramps via ACCEL_DURATION/DECEL_DURATION
let lastMoveDirection: Cesium.Cartesian3 | null = null; // kept so deceleration continues in a straight line after release
let movementFrameHandle: number | null = null;
let lastFrameTime: number | null = null;

function stopMovementLoop(): void {
  if (movementFrameHandle !== null) {
    cancelAnimationFrame(movementFrameHandle);
    movementFrameHandle = null;
  }
  lastFrameTime = null;
  currentSpeed = 0;
  lastMoveDirection = null;
}

function movementFrame(now: number): void {
  if (!movementViewer) {
    movementFrameHandle = null;
    return;
  }
  if (lastFrameTime === null) lastFrameTime = now;
  // Clamped so a stalled tab (backgrounded, GC pause) resumes with one
  // capped step instead of the camera teleporting to make up lost time.
  const dt = Math.min((now - lastFrameTime) / 1000, 1 / 20);
  lastFrameTime = now;

  const anyInput = forwardInput !== 0 || strafeInput !== 0;
  const targetSpeed = anyInput ? IndoorCameraConfig.MOVE_SPEED : 0;
  const rampRate = anyInput
    ? IndoorCameraConfig.MOVE_SPEED / IndoorCameraConfig.ACCEL_DURATION
    : IndoorCameraConfig.MOVE_SPEED / IndoorCameraConfig.DECEL_DURATION;
  currentSpeed = Math.min(
    IndoorCameraConfig.MAX_MOVE_SPEED,
    moveToward(currentSpeed, targetSpeed, rampRate * dt)
  );

  if (currentSpeed > 1e-4) {
    const camera = movementViewer.camera;
    const origin = Cesium.Cartesian3.clone(camera.positionWC);
    const zone = indoorState.zone;
    const forwardAxis = zone ? zone.forward : camera.directionWC;
    const rightAxis = zone
      ? zone.right
      : Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.cross(camera.directionWC, camera.upWC, new Cesium.Cartesian3()),
          new Cesium.Cartesian3()
        );
    const direction = computeMoveDirection(forwardAxis, rightAxis, forwardInput, strafeInput, lastMoveDirection);

    if (direction) {
      lastMoveDirection = direction;
      const requested = currentSpeed * dt;

      const target = zone
        ? computeZoneClampedTarget(movementViewer.scene, origin, direction, requested, zone)
        : (() => {
            // No zone active (shouldn't normally happen — every indoor
            // enter() creates one — but fails safe to the old wall-raycast-
            // only behavior rather than refusing to move at all).
            const flatDirection = flattenHorizontal(origin, direction);
            const allowed = clampMovementDistance(movementViewer!.scene, origin, flatDirection, requested);
            if (allowed <= 1e-6) return origin;
            return Cesium.Cartesian3.add(
              origin,
              Cesium.Cartesian3.multiplyByScalar(flatDirection, allowed, new Cesium.Cartesian3()),
              new Cesium.Cartesian3()
            );
          })();

      if (Cesium.Cartesian3.equalsEpsilon(target, origin, 1e-9)) {
        // Blocked (wall) or fully soft-stopped at a zone limit — kill
        // velocity immediately rather than sliding, so holding a movement
        // key into a boundary doesn't build up speed that then lurches
        // sideways once another direction is added.
        currentSpeed = 0;
      } else {
        // Re-lock height every frame — walking must never drift the eye
        // level up/down even on sloped floors or float rounding.
        const targetCartographic = Cesium.Cartographic.fromCartesian(target);
        if (indoorState.eyeHeight !== null) targetCartographic.height = indoorState.eyeHeight;
        camera.position = Cesium.Cartographic.toCartesian(
          targetCartographic,
          Cesium.Ellipsoid.WGS84,
          new Cesium.Cartesian3()
        );
        // Safety net under requestRenderMode — this is a custom rAF loop,
        // not Cesium's own controller/flight code, so don't rely solely on
        // Cesium's own camera-changed auto-detection for something as
        // sensitive as walking around indoors.
        movementViewer.scene.requestRender();
      }
    }
  }

  if (currentSpeed <= 1e-4 && !anyInput) {
    stopMovementLoop();
    return;
  }

  movementFrameHandle = requestAnimationFrame(movementFrame);
}

function ensureMovementLoop(viewer: Cesium.Viewer): void {
  movementViewer = viewer;
  if (movementFrameHandle !== null) return;
  lastFrameTime = null;
  movementFrameHandle = requestAnimationFrame(movementFrame);
}

/** Sets the held forward/backward axis: 1 = forward, -1 = backward, 0 = released. Movement itself ramps up/down smoothly over ACCEL_DURATION/DECEL_DURATION — this only changes what the loop is steering toward. */
export function setForwardInput(viewer: Cesium.Viewer, value: -1 | 0 | 1): void {
  forwardInput = value;
  ensureMovementLoop(viewer);
}

/** Sets the held strafe axis: 1 = right, -1 = left, 0 = released. */
export function setStrafeInput(viewer: Cesium.Viewer, value: -1 | 0 | 1): void {
  strafeInput = value;
  ensureMovementLoop(viewer);
}

/** True while any indoor movement (walk/strafe ramp, rotate, or a Q/E height nudge) is actively running. enforceIndoorHeight uses this to stay out of the way — its own hard, instant snap was fighting the smooth animation frame-by-frame, which is what caused movement to visibly jerk partway through instead of gliding to a stop. */
function isAnimating(): boolean {
  return movementFrameHandle !== null || activeRotationFrame !== null || activeHeightFrame !== null;
}

let activeRotationFrame: number | null = null;
let activeHeightFrame: number | null = null;

/** Rotates heading only (yaw) — position never changes. Positive angleRad = clockwise. Always eased, never instant. */
export function rotateIndoorCamera(viewer: Cesium.Viewer, angleRad: number, durationSeconds: number): void {
  if (activeRotationFrame !== null) {
    cancelAnimationFrame(activeRotationFrame);
    activeRotationFrame = null;
  }

  const camera = viewer.camera;
  const startHeading = camera.heading;
  const targetHeading = startHeading + angleRad;

  if (!IndoorCameraConfig.ENABLE_SMOOTH) {
    camera.setView({ orientation: { heading: targetHeading, pitch: camera.pitch, roll: 0 } });
    return;
  }

  const durationMs = durationSeconds * 1000;
  const startTime = performance.now();

  function frame(now: number) {
    const t = Math.min(1, (now - startTime) / durationMs);
    // Ease-out (cubic) so the turn decelerates into its final heading
    // instead of stopping abruptly — matches the walk/strafe deceleration feel.
    const eased = 1 - Math.pow(1 - t, 3);
    const heading = Cesium.Math.lerp(startHeading, targetHeading, eased);
    camera.setView({ orientation: { heading, pitch: camera.pitch, roll: 0 } });
    viewer.scene.requestRender();
    if (t < 1) {
      activeRotationFrame = requestAnimationFrame(frame);
    } else {
      activeRotationFrame = null;
    }
  }
  activeRotationFrame = requestAnimationFrame(frame);
}

/** Keyboard Q/E — the only sanctioned way to change eye height indoors (spec section 4). Eased, same as every other indoor movement — never an instant teleport. */
export function stepIndoorHeight(viewer: Cesium.Viewer, signedDelta: number): void {
  if (indoorState.eyeHeight === null) return;
  const camera = viewer.camera;
  const startCartographic = Cesium.Cartographic.fromCartesian(camera.positionWC);
  const startHeight = startCartographic.height;
  const targetHeight = indoorState.eyeHeight + signedDelta;
  indoorState.eyeHeight = targetHeight;

  if (activeHeightFrame !== null) {
    cancelAnimationFrame(activeHeightFrame);
    activeHeightFrame = null;
  }

  if (!IndoorCameraConfig.ENABLE_SMOOTH) {
    startCartographic.height = targetHeight;
    camera.position = Cesium.Cartographic.toCartesian(startCartographic, Cesium.Ellipsoid.WGS84, new Cesium.Cartesian3());
    return;
  }

  const durationMs = IndoorCameraConfig.MOVE_DURATION * 1000;
  const startTime = performance.now();

  function frame(now: number) {
    const t = Math.min(1, (now - startTime) / durationMs);
    const cartographic = Cesium.Cartographic.fromCartesian(camera.positionWC);
    cartographic.height = Cesium.Math.lerp(startHeight, targetHeight, t);
    camera.position = Cesium.Cartographic.toCartesian(cartographic, Cesium.Ellipsoid.WGS84, new Cesium.Cartesian3());
    viewer.scene.requestRender();
    if (t < 1) {
      activeHeightFrame = requestAnimationFrame(frame);
    } else {
      activeHeightFrame = null;
    }
  }
  activeHeightFrame = requestAnimationFrame(frame);
}

/**
 * Continuously re-locks height every frame — a cheap safety net against any
 * drift from rotation/look/tilt while indoor. Deliberately skipped while a
 * move/strafe/rotate/height animation is actively running: those already
 * land at the exact right height on their own, and this hard, un-eased
 * snap fighting a smooth in-flight animation is what caused visible
 * mid-movement jerks.
 */
export function enforceIndoorHeight(viewer: Cesium.Viewer): void {
  if (indoorState.eyeHeight === null) return;
  if (isAnimating()) return;
  const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
  if (Math.abs(cartographic.height - indoorState.eyeHeight) < 1e-3) return;
  cartographic.height = indoorState.eyeHeight;
  viewer.camera.position = Cesium.Cartographic.toCartesian(
    cartographic,
    Cesium.Ellipsoid.WGS84,
    new Cesium.Cartesian3()
  );
  // This runs inside scene.postRender — i.e. AFTER a render already
  // happened. Under requestRenderMode nothing else guarantees another
  // render will follow just because the camera moved here, so without this
  // the correction could sit applied-but-unrendered indefinitely.
  viewer.scene.requestRender();
}

/**
 * Caps look pitch to ±MAX_PITCH_DEG from level — position stays pinned
 * inside the movement zone regardless of look direction, but the view
 * itself is still capped so a mouse-drag look can't flip the camera past
 * straight up/down. Unlike enforceIndoorHeight, this always runs (never
 * skipped during other animations) since nothing else in this file ever
 * changes pitch.
 */
export function enforceIndoorPitchClamp(viewer: Cesium.Viewer): void {
  const camera = viewer.camera;
  const maxPitch = Cesium.Math.toRadians(IndoorMovementConfig.MAX_PITCH_DEG);
  if (camera.pitch > maxPitch) {
    camera.setView({ orientation: { heading: camera.heading, pitch: maxPitch, roll: 0 } });
    viewer.scene.requestRender();
  } else if (camera.pitch < -maxPitch) {
    camera.setView({ orientation: { heading: camera.heading, pitch: -maxPitch, roll: 0 } });
    viewer.scene.requestRender();
  }
}

export function cancelIndoorMovement(): void {
  forwardInput = 0;
  strafeInput = 0;
  movementViewer = null;
  stopMovementLoop();
  if (activeRotationFrame !== null) {
    cancelAnimationFrame(activeRotationFrame);
    activeRotationFrame = null;
  }
  if (activeHeightFrame !== null) {
    cancelAnimationFrame(activeHeightFrame);
    activeHeightFrame = null;
  }
}
