import { MovementButton } from "./MovementButton";
import { RotateButton } from "./RotateButton";
import { ArrowUpIcon, ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon } from "./IndoorNavigationIcons";
import { useIndoorMovement } from "./useIndoorMovement";
import "./IndoorNavigation.css";

/**
 * Floating FPS-style movement controller — appears ONLY while indoor mode
 * is active (see IndoorCameraController) and disappears the instant it
 * isn't, without ever occupying layout space. Every button (and the
 * keyboard arrows/R it mirrors) calls indoorCamera.move*()/rotateClockwise()
 * — this component never touches the Cesium camera directly.
 */
export function IndoorNavigationOverlay() {
  const { isIndoor, forwardHandlers, backwardHandlers, nudgeRotateLeft, nudgeRotateRight, rotateClockwise } =
    useIndoorMovement();

  if (!isIndoor) return null;

  return (
    <>
      <div className="indoor-nav" role="group" aria-label="Indoor camera navigation">
        <div className="indoor-nav__pad">
          <MovementButton
            className="indoor-nav__btn--up"
            icon={<ArrowUpIcon className="indoor-nav__icon" />}
            label="Move forward"
            tooltip="Move Forward (0.5 m)"
            {...forwardHandlers}
          />
          {/* Single click, not hold-to-strafe — rotates the view in place by a
              small fixed angle (IndoorCameraConfig.NUDGE_ROTATE_STEP_DEG),
              same interaction pattern as the center rotate button, not
              continuous movement. */}
          <button
            type="button"
            className="indoor-nav__btn indoor-nav__btn--left"
            aria-label="Rotate view left 5 degrees"
            title="Rotate Left 5°"
            onClick={nudgeRotateLeft}
          >
            <ArrowLeftIcon className="indoor-nav__icon" />
          </button>
          <RotateButton onRotate={rotateClockwise} />
          <button
            type="button"
            className="indoor-nav__btn indoor-nav__btn--right"
            aria-label="Rotate view right 5 degrees"
            title="Rotate Right 5°"
            onClick={nudgeRotateRight}
          >
            <ArrowRightIcon className="indoor-nav__icon" />
          </button>
          <MovementButton
            className="indoor-nav__btn--down"
            icon={<ArrowDownIcon className="indoor-nav__icon" />}
            label="Move backward"
            tooltip="Move Backward (0.5 m)"
            {...backwardHandlers}
          />
        </div>
      </div>
    </>
  );
}
