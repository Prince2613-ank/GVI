import { RotateClockwiseIcon } from "./IndoorNavigationIcons";

interface RotateButtonProps {
  onRotate: () => void;
}

/** Center control — single press rotates 30° clockwise; no hold-repeat (rotation isn't a continuous action like movement). */
export function RotateButton({ onRotate }: RotateButtonProps) {
  return (
    <button
      type="button"
      className="indoor-nav__btn indoor-nav__btn--rotate"
      aria-label="Rotate camera 30 degrees clockwise"
      title="Rotate 30°"
      onClick={onRotate}
    >
      <RotateClockwiseIcon className="indoor-nav__icon" />
    </button>
  );
}
