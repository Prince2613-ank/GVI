/** Tunable constants for Indoor Camera Mode — see src/features/indoor-camera/README (this file's own comments) for what each one controls. */
export const IndoorCameraConfig = {
  /** Walking speed, in meters/second, once fully accelerated. */
  MOVE_SPEED: 11,
  /** Hard ceiling on movement speed, in meters/second — never exceeded regardless of input. */
  MAX_MOVE_SPEED: 12,
  /** Seconds to ramp from a standstill up to MOVE_SPEED on press — longer than before so the higher top speed still eases in smoothly instead of lurching. */
  ACCEL_DURATION: 0.3,
  /** Seconds to ramp from MOVE_SPEED back down to a standstill on release — longer than before to match, so stopping at higher speed still glides instead of snapping. */
  DECEL_DURATION: 0.3,
  /** Seconds the eased height-nudge (Q/E) interpolation takes to complete. */
  MOVE_DURATION: 0.15,
  /**
   * Collision raycasts (scene.pickFromRay) are a synchronous GPU readback —
   * too expensive to run on every single animation frame. Reusing the last
   * raycast's result for this many ms (or until the camera has moved/turned
   * enough to invalidate it — see IndoorCollision.ts) keeps per-frame
   * movement smooth without a fresh GPU pick every frame. Kept short because
   * continuous movement only travels ~1-3cm/frame, so staleness never
   * exceeds COLLISION_PADDING.
   */
  COLLISION_CACHE_MS: 80,
  /** Radians per pixel of mouse drag for yaw/pitch look. */
  ROTATE_SPEED: 0.0035,
  /** Meters of buffer kept between the camera and any collided surface. */
  COLLISION_PADDING: 0.1,
  /** Master switch for eased interpolation vs. an instant snap (kept for debugging/testing). */
  ENABLE_SMOOTH: true,
  /** Meters moved per keyboard Q/E press — the only sanctioned way to change eye height indoors. */
  VERTICAL_STEP: 0.3,
  /** Degrees the center rotate button turns per press. */
  ROTATE_STEP_DEG: 30,
  /** Seconds the rotate-button turn takes, eased — never instant. */
  ROTATE_DURATION: 0.25,
  /** Degrees the left/right pad buttons nudge the view per press — position never changes, only heading. */
  NUDGE_ROTATE_STEP_DEG: 5,
  /** Seconds the left/right nudge-rotate takes, eased (ease-out) — never instant. */
  NUDGE_ROTATE_DURATION: 0.2,
} as const;
