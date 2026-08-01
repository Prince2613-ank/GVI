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
  const { isIndoor, forwardHandlers, backwardHandlers, leftHandlers, rightHandlers, rotateClockwise } =
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
          <MovementButton
            className="indoor-nav__btn--left"
            icon={<ArrowLeftIcon className="indoor-nav__icon" />}
            label="Move left"
            tooltip="Move Left"
            {...leftHandlers}
          />
          <RotateButton onRotate={rotateClockwise} />
          <MovementButton
            className="indoor-nav__btn--right"
            icon={<ArrowRightIcon className="indoor-nav__icon" />}
            label="Move right"
            tooltip="Move Right"
            {...rightHandlers}
          />
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
