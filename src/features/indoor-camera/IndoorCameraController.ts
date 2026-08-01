import * as Cesium from "cesium";
import { IndoorCameraConfig } from "./IndoorCameraConfig";
import { IndoorMovementConfig } from "./IndoorMovementConfig";
import { attachIndoorInput } from "./IndoorInput";
import {
  enforceIndoorHeight,
  enforceIndoorPitchClamp,
  cancelIndoorMovement,
  setForwardInput,
  setStrafeInput,
  rotateIndoorCamera,
} from "./IndoorMovement";
import { createIndoorZone, showIndoorZoneDebug, IndoorZone } from "./IndoorZone";
import { indoorState, setIndoorEntered, setIndoorExited, subscribeIndoorState, getIsIndoorSnapshot } from "./IndoorState";
import { BalconySide } from "../balcony-debug/BalconyTypes";

let detachInput: (() => void) | null = null;
let detachPostRender: (() => void) | null = null;
/** The viewer indoor mode is currently active on — lets moveForward()/etc. be called without the UI needing its own viewer reference. */
let activeViewer: Cesium.Viewer | null = null;
/** Runtime override for IndoorMovementConfig.ENABLE_DEBUG — see setDebugEnabled(). */
let debugEnabled: boolean = IndoorMovementConfig.ENABLE_DEBUG;
let detachDebug: (() => void) | null = null;

function attachDebugIfEnabled(viewer: Cesium.Viewer, zone: IndoorZone): void {
  detachDebug?.();
  detachDebug = debugEnabled ? showIndoorZoneDebug(viewer, zone) : null;
}

/**
 * Public entry point for Indoor Camera Mode — the rest of the app should
 * only ever call enter()/exit()/update() and the move-/rotate- methods (plus
 * isIndoor()/subscribe() to read/observe state); everything else in this
 * folder is an implementation detail.
 *
 * enter(): call right after flying the camera to a balcony/indoor
 * viewpoint. eyeHeightM is the ellipsoidal height that pose sits at — it
 * becomes the locked "floor level" that mouse-wheel steps and camera
 * rotation can never drift away from. The camera's pose at this exact
 * moment is also frozen into a local movement zone (see IndoorZone.ts) —
 * all subsequent movement is clamped inside it, which is what keeps the
 * user pinned near this specific window/balcony instead of able to wander
 * off through the building. `side`, if given, is the balcony's facing
 * direction — it selects a per-facing forward-limit override (see
 * IndoorMovementConfig.FORWARD_LIMIT_BY_SIDE).
 */
function enter(viewer: Cesium.Viewer, eyeHeightM: number, side?: BalconySide): void {
  // Re-entering (e.g. jumping straight from one balcony to another) tears
  // down the previous session's listeners first so nothing double-attaches.
  if (indoorState.isIndoor) exit(viewer);

  activeViewer = viewer;
  const zone = createIndoorZone(viewer, eyeHeightM, side);
  setIndoorEntered(eyeHeightM, zone);
  detachInput = attachIndoorInput(viewer);
  attachDebugIfEnabled(viewer, zone);

  const onPostRender = () => {
    enforceIndoorHeight(viewer);
    enforceIndoorPitchClamp(viewer);
  };
  viewer.scene.postRender.addEventListener(onPostRender);
  detachPostRender = () => viewer.scene.postRender.removeEventListener(onPostRender);
}

/** Call when the camera leaves the building (e.g. the Home button, or flying to an outdoor/aerial shot). */
function exit(_viewer: Cesium.Viewer): void {
  if (!indoorState.isIndoor) return;

  cancelIndoorMovement();
  detachInput?.();
  detachInput = null;
  detachPostRender?.();
  detachPostRender = null;
  detachDebug?.();
  detachDebug = null;
  activeViewer = null;
  setIndoorExited();
}

/**
 * Toggles the "Indoor Debug" overlay (green movement-volume wireframe, cyan
 * window plane, red live position dot — see IndoorZone.ts) for the CURRENT
 * viewpoint, if indoor mode is active, and remembers the setting for the
 * next enter() too.
 */
function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
  if (activeViewer && indoorState.zone) {
    attachDebugIfEnabled(activeViewer, indoorState.zone);
  }
}

function isDebugEnabled(): boolean {
  return debugEnabled;
}

export interface IndoorZoneLimits {
  forwardLimit: number;
  backLimit: number;
  sideLimit: number;
}

/** Current viewpoint's movement limits (see IndoorZone.ts), for a debug UI to read and display — null if indoor mode isn't active. */
function getActiveZoneLimits(): IndoorZoneLimits | null {
  const zone = indoorState.zone;
  if (!zone) return null;
  return { forwardLimit: zone.forwardLimit, backLimit: zone.backLimit, sideLimit: zone.sideLimit };
}

/**
 * Live-edits the CURRENT viewpoint's movement limits — lets a debug panel
 * dial in exactly how far the camera can move around this specific
 * balcony/window without touching IndoorMovementConfig.ts and reloading.
 * Only mutates the in-memory zone for this session; re-entering (or
 * entering a different) viewpoint recomputes a fresh zone from
 * IndoorMovementConfig's defaults, so nothing here persists across visits.
 * A no-op if indoor mode isn't currently active.
 */
function setActiveZoneLimits(overrides: Partial<IndoorZoneLimits>): void {
  const zone = indoorState.zone;
  if (!zone) return;
  if (overrides.forwardLimit !== undefined) zone.forwardLimit = Math.max(0, overrides.forwardLimit);
  if (overrides.backLimit !== undefined) zone.backLimit = Math.max(0, overrides.backLimit);
  if (overrides.sideLimit !== undefined) zone.sideLimit = Math.max(0, overrides.sideLimit);
  // Redraw the debug volume at its new size immediately, if it's showing.
  if (activeViewer) attachDebugIfEnabled(activeViewer, zone);
}

/**
 * Per-frame safety hook — indoor height enforcement is already wired
 * automatically via scene.postRender in enter(), so calling this manually
 * is optional; it's exposed for callers that want an explicit tick (e.g.
 * running it once after a manual camera.position mutation elsewhere).
 */
function update(viewer: Cesium.Viewer): void {
  if (!indoorState.isIndoor) return;
  enforceIndoorHeight(viewer);
}

function isIndoor(): boolean {
  return indoorState.isIndoor;
}

// ---- Movement API used by the indoor navigation overlay + keyboard ----
// FPS-style press-to-start / release-to-stop: these set which way the
// continuous velocity-based movement loop is steering, they don't move the
// camera themselves. Every one of these is a no-op when indoor mode isn't
// active, so callers (button press/release, held keys) never need to guard
// on isIndoor() themselves.

function startForward(): void {
  if (!activeViewer) return;
  setForwardInput(activeViewer, 1);
}

function startBackward(): void {
  if (!activeViewer) return;
  setForwardInput(activeViewer, -1);
}

function stopForwardBackward(): void {
  if (!activeViewer) return;
  setForwardInput(activeViewer, 0);
}

function startLeft(): void {
  if (!activeViewer) return;
  setStrafeInput(activeViewer, -1);
}

function startRight(): void {
  if (!activeViewer) return;
  setStrafeInput(activeViewer, 1);
}

function stopStrafe(): void {
  if (!activeViewer) return;
  setStrafeInput(activeViewer, 0);
}

/** Rotates 30° clockwise in place, eased over ROTATE_DURATION with ease-out — never instant. */
function rotateClockwise(): void {
  if (!activeViewer) return;
  rotateIndoorCamera(
    activeViewer,
    Cesium.Math.toRadians(IndoorCameraConfig.ROTATE_STEP_DEG),
    IndoorCameraConfig.ROTATE_DURATION
  );
}

export const indoorCamera = {
  enter,
  exit,
  update,
  isIndoor,
  startForward,
  startBackward,
  stopForwardBackward,
  startLeft,
  startRight,
  stopStrafe,
  rotateClockwise,
  setDebugEnabled,
  isDebugEnabled,
  getActiveZoneLimits,
  setActiveZoneLimits,
  /** Subscribes to isIndoor/zone changes — for React via useSyncExternalStore, or a plain effect that just wants to know when a new viewpoint's zone lands. Returns an unsubscribe function. */
  subscribe: subscribeIndoorState,
  getSnapshot: getIsIndoorSnapshot,
};
