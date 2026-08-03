import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { indoorCamera } from "../indoor-camera/IndoorCameraController";

/** Reactive isIndoor — re-renders the overlay in/out exactly when indoor mode toggles. */
export function useIsIndoor(): boolean {
  return useSyncExternalStore(indoorCamera.subscribe, indoorCamera.getSnapshot, indoorCamera.getSnapshot);
}

interface HoldHandlers {
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerLeave: (event: React.PointerEvent) => void;
}

/**
 * A quick tap released well inside the accel ramp (IndoorCameraConfig.
 * ACCEL_DURATION) would barely have picked up any speed before decelerating
 * again — the click would visibly do nothing. Holding the input active for
 * at least this long guarantees every click, not just a held press,
 * produces a real step forward.
 */
const MIN_HOLD_MS = 250;

/**
 * Press-to-start / release-to-stop, FPS-controller style — press fires a
 * "start" call once (which begins the continuous velocity ramp-up in
 * IndoorMovement.ts); release fires "stop" once (which begins the
 * ramp-down), but not before MIN_HOLD_MS has elapsed since the press, so a
 * plain click still moves the camera instead of being swallowed by the
 * ramp-up. Neither start nor stop moves the camera directly or repeats on a
 * timer; all the actual per-frame motion happens in the rAF loop they steer.
 */
function useHold(onStart: () => void, onStop: () => void): HoldHandlers & { start: () => void; stop: () => void } {
  const activeRef = useRef(false);
  const pressedAtRef = useRef(0);
  const pendingStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingStop = useCallback(() => {
    if (pendingStopRef.current !== null) {
      clearTimeout(pendingStopRef.current);
      pendingStopRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    clearPendingStop();
    if (activeRef.current) return;
    activeRef.current = true;
    pressedAtRef.current = performance.now();
    onStart();
  }, [onStart, clearPendingStop]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    const elapsed = performance.now() - pressedAtRef.current;
    const remaining = MIN_HOLD_MS - elapsed;

    if (remaining <= 0) {
      activeRef.current = false;
      onStop();
      return;
    }

    clearPendingStop();
    pendingStopRef.current = setTimeout(() => {
      pendingStopRef.current = null;
      activeRef.current = false;
      onStop();
    }, remaining);
  }, [onStop, clearPendingStop]);

  useEffect(() => {
    return () => {
      clearPendingStop();
      if (activeRef.current) {
        activeRef.current = false;
        onStop();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    start,
    stop,
    onPointerDown: (event) => {
      event.preventDefault();
      start();
    },
    onPointerUp: stop,
    onPointerLeave: stop,
  };
}

/**
 * Wires the four directional keys + R to the SAME IndoorCameraController
 * methods the overlay buttons call — keyboard and UI never diverge into two
 * separate movement code paths. Only active while indoor.
 */
function useIndoorKeyboard(isIndoor: boolean): void {
  const forward = useHold(indoorCamera.startForward, indoorCamera.stopForwardBackward);
  const backward = useHold(indoorCamera.startBackward, indoorCamera.stopForwardBackward);
  const left = useHold(indoorCamera.startLeft, indoorCamera.stopStrafe);
  const right = useHold(indoorCamera.startRight, indoorCamera.stopStrafe);

  useEffect(() => {
    if (!isIndoor) return;

    function onKeyDown(event: KeyboardEvent) {
      // event.repeat is true for the browser's own key-repeat while held —
      // start() already no-ops if this axis is already active, but skipping
      // repeats here avoids redundant calls entirely.
      if (event.repeat) return;
      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          forward.start();
          break;
        case "ArrowDown":
          event.preventDefault();
          backward.start();
          break;
        case "ArrowLeft":
          event.preventDefault();
          left.start();
          break;
        case "ArrowRight":
          event.preventDefault();
          right.start();
          break;
        case "r":
        case "R":
          indoorCamera.rotateClockwise();
          break;
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      switch (event.key) {
        case "ArrowUp":
          forward.stop();
          break;
        case "ArrowDown":
          backward.stop();
          break;
        case "ArrowLeft":
          left.stop();
          break;
        case "ArrowRight":
          right.stop();
          break;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      forward.stop();
      backward.stop();
      left.stop();
      right.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isIndoor]);
}

/**
 * Everything the IndoorNavigationOverlay needs: reactive isIndoor, press-
 * to-start/release-to-stop pointer handlers for each of the four directions
 * (bound to the exact same indoorCamera methods keyboard input uses), and a
 * single-shot rotate action. No Cesium camera access happens here or in any
 * component that consumes this hook — it only ever calls indoorCamera.*
 * methods.
 */
export function useIndoorMovement() {
  const isIndoor = useIsIndoor();
  useIndoorKeyboard(isIndoor);

  const forward = useHold(indoorCamera.startForward, indoorCamera.stopForwardBackward);
  const backward = useHold(indoorCamera.startBackward, indoorCamera.stopForwardBackward);

  return {
    isIndoor,
    forwardHandlers: forward,
    backwardHandlers: backward,
    // Single-press nudge-rotate, not hold-to-strafe — position never
    // changes, only heading, so this doesn't need useHold's press/release
    // ramp (same reasoning as the center rotate button).
    nudgeRotateLeft: indoorCamera.nudgeRotateLeft,
    nudgeRotateRight: indoorCamera.nudgeRotateRight,
    rotateClockwise: indoorCamera.rotateClockwise,
  };
}
