import { ReactNode } from "react";

interface MovementButtonProps {
  icon: ReactNode;
  label: string;
  tooltip: string;
  className: string;
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerLeave: (event: React.PointerEvent) => void;
}

/**
 * A single directional control. Purely presentational + input plumbing —
 * it never touches Cesium or IndoorCameraController itself; the press/hold
 * handlers it's given (from useIndoorMovement) already call the right
 * indoorCamera.move*() method.
 */
export function MovementButton({
  icon,
  label,
  tooltip,
  className,
  onPointerDown,
  onPointerUp,
  onPointerLeave,
}: MovementButtonProps) {
  return (
    <button
      type="button"
      className={`indoor-nav__btn ${className}`}
      aria-label={label}
      title={tooltip}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onContextMenu={(event) => event.preventDefault()}
    >
      {icon}
    </button>
  );
}
