import * as Cesium from "cesium";
import { IndoorCameraConfig } from "./IndoorCameraConfig";
import { stepIndoorHeight, setForwardInput } from "./IndoorMovement";

interface ControllerSnapshot {
  enableZoom: boolean;
  enableTranslate: boolean;
  enableLook: boolean;
  enableTilt: boolean;
  enableRotate: boolean;
  enableCollisionDetection: boolean;
  inertiaSpin: number;
  inertiaTranslate: number;
  inertiaZoom: number;
  lookEventTypes: unknown;
}

function snapshotController(controller: Cesium.ScreenSpaceCameraController): ControllerSnapshot {
  return {
    enableZoom: controller.enableZoom,
    enableTranslate: controller.enableTranslate,
    enableLook: controller.enableLook,
    enableTilt: controller.enableTilt,
    enableRotate: controller.enableRotate,
    enableCollisionDetection: controller.enableCollisionDetection,
    inertiaSpin: controller.inertiaSpin,
    inertiaTranslate: controller.inertiaTranslate,
    inertiaZoom: controller.inertiaZoom,
    lookEventTypes: controller.lookEventTypes,
  };
}

function applyIndoorController(controller: Cesium.ScreenSpaceCameraController): void {
  // Cesium's default "rotate" (enableRotate) behavior on plain left-drag is
  // an ORBIT — it actually MOVES the camera position around a pivot point
  // on the ground/model, not an in-place look. Leaving it on alongside
  // enableLook is exactly what was making the camera visibly "throw" itself
  // during a drag. For true FPS-style look (yaw/pitch, camera position
  // NEVER changes from a drag), rotate must be off and look must be
  // remapped onto plain left-drag (it defaults to Ctrl+left-drag).
  //
  // Cesium's own zoom/inertia are disabled (inertiaSpin/Translate/Zoom = 0,
  // enableZoom = false): they fight the custom smooth ramp-up/ramp-down and
  // produce exactly the kind of uncontrolled drift an FPS-style controller
  // must never have. The wheel is instead repurposed below to drive the
  // SAME continuous velocity-based forward/backward loop the nav
  // buttons/arrow keys use, rather than Cesium's built-in zoom.
  controller.enableZoom = false;
  controller.enableTranslate = false;
  controller.enableRotate = false;
  controller.enableLook = true;
  controller.lookEventTypes = [Cesium.CameraEventType.LEFT_DRAG];
  controller.enableTilt = true;
  controller.enableCollisionDetection = true;
  controller.inertiaSpin = 0;
  controller.inertiaTranslate = 0;
  controller.inertiaZoom = 0;
}

function restoreController(controller: Cesium.ScreenSpaceCameraController, snapshot: ControllerSnapshot): void {
  controller.enableZoom = snapshot.enableZoom;
  controller.enableTranslate = snapshot.enableTranslate;
  controller.enableLook = snapshot.enableLook;
  controller.enableTilt = snapshot.enableTilt;
  controller.enableRotate = snapshot.enableRotate;
  controller.enableCollisionDetection = snapshot.enableCollisionDetection;
  controller.inertiaSpin = snapshot.inertiaSpin;
  controller.inertiaTranslate = snapshot.inertiaTranslate;
  controller.inertiaZoom = snapshot.inertiaZoom;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  controller.lookEventTypes = snapshot.lookEventTypes as any;
}

/**
 * Wires up Indoor Camera Mode's input handling: tames the default Cesium
 * controller (no zoom/translate/orbit, no inertia — see
 * applyIndoorController), maps the mouse wheel onto the same continuous
 * forward/backward loop the nav overlay buttons + arrow keys drive, and
 * adds the Q/E keyboard height nudges. Returns a cleanup function that
 * restores everything exactly as it was — call it once on
 * indoorCamera.exit().
 */
export function attachIndoorInput(viewer: Cesium.Viewer): () => void {
  const controller = viewer.scene.screenSpaceCameraController;
  const snapshot = snapshotController(controller);
  applyIndoorController(controller);

  // A wheel "notch" is treated like a brief button hold rather than an
  // instant teleport: it sets the forward/backward input axis (so the
  // existing accel/decel ramp in IndoorMovement.ts applies), then
  // auto-releases it a moment later. Scrolling again before that timer
  // fires just keeps it going, so a continuous scroll gesture reads as one
  // continuous held-forward walk instead of a stutter of separate steps.
  const WHEEL_HOLD_MS = 220;
  let wheelReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  const wheelHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  wheelHandler.setInputAction((delta: number) => {
    // Cesium's WHEEL delta sign is "scroll away from the screen" = positive;
    // treat that as stepping backward, and the opposite as forward.
    const direction = delta > 0 ? -1 : 1;
    setForwardInput(viewer, direction);

    if (wheelReleaseTimer !== null) clearTimeout(wheelReleaseTimer);
    wheelReleaseTimer = setTimeout(() => {
      wheelReleaseTimer = null;
      setForwardInput(viewer, 0);
    }, WHEEL_HOLD_MS);
  }, Cesium.ScreenSpaceEventType.WHEEL);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "q" || event.key === "Q") {
      stepIndoorHeight(viewer, -IndoorCameraConfig.VERTICAL_STEP);
    } else if (event.key === "e" || event.key === "E") {
      stepIndoorHeight(viewer, IndoorCameraConfig.VERTICAL_STEP);
    }
  }
  window.addEventListener("keydown", onKeyDown);

  return () => {
    if (wheelReleaseTimer !== null) clearTimeout(wheelReleaseTimer);
    wheelHandler.destroy();
    window.removeEventListener("keydown", onKeyDown);
    if (!viewer.isDestroyed()) {
      restoreController(controller, snapshot);
    }
  };
}
