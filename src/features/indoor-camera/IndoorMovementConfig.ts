/**
 * Tunable constants for the per-viewpoint local movement boundary system —
 * see IndoorZone.ts for how these are turned into an actual clamped volume
 * around each saved balcony/window viewpoint.
 */
export const IndoorMovementConfig = {
  /** Meters allowed toward the window from the saved eye position, before the auto-detected window-plane safety clamp (see WINDOW_PADDING) tightens it further. Used for any facing not listed in FORWARD_LIMIT_BY_SIDE. */
  FORWARD_LIMIT: 4.0,
  /**
   * Per-facing override for FORWARD_LIMIT, applied by BalconySide — e.g.
   * north-facing flats get a deliberately larger "maximum view" allowance
   * for every floor, since that's the side with the most open outlook.
   * Sides not listed here fall back to the plain FORWARD_LIMIT above. Still
   * subject to the same window-plane safety clamp (WINDOW_PADDING) as
   * everything else — this only raises the ceiling, never bypasses it.
   */
  FORWARD_LIMIT_BY_SIDE: {
    North: 7,
    South: 7,
    East: 4.2,
    West: 5.2,
  } as Partial<Record<"North" | "South" | "East" | "West", number>>,
  /**
   * Sides listed here skip the auto-detected window-plane safety clamp
   * entirely — their FORWARD_LIMIT_BY_SIDE (or FORWARD_LIMIT) value always
   * applies as-is, even if a nearer window/glass surface is detected.
   * Deliberately requested for North specifically (its "maximum view"
   * ceiling was otherwise always being overridden down to whatever glass
   * sits a couple meters away in a normal room) — this trades away the
   * "never pass through the glass" guarantee on these sides, so use
   * sparingly and only where that's actually wanted.
   */
  IGNORE_WINDOW_DETECTION_FOR_SIDES: ["North"] as Array<"North" | "South" | "East" | "West">,
  /** Meters allowed back into the room from the saved eye position. */
  BACK_LIMIT: 1.2,
  /** Meters allowed left/right of the saved eye position. Kept large enough that the lateral shift reads clearly as movement rather than just a parallax angle-change when standing close to a narrow window opening. */
  SIDE_LIMIT: 1.4,
  /** Minimum distance kept between the eye and the detected window/glass plane — the eye position may never cross closer than this. */
  WINDOW_PADDING: 0.15,
  /** Distance (meters) from any boundary over which movement speed ramps smoothly down to zero, instead of cutting off abruptly at the hard limit. */
  SOFT_ZONE: 0.2,
  /** Vertical movement is always locked to the saved eye height indoors — kept here as an explicit, named toggle rather than an unconditional assumption buried in the movement code. */
  LOCK_HEIGHT: true,
  /** Draws the movement volume/limits/window plane/live position as a debug overlay when true. Toggle at runtime via indoorCamera.setDebugEnabled()/the "Indoor Debug" UI control — this is only the default at first load. */
  ENABLE_DEBUG: false,
  /** Degrees of pitch allowed up/down from level while indoor. Position stays pinned inside the movement zone regardless of look direction, but pitch itself is capped so the view can't flip upside down. */
  MAX_PITCH_DEG: 70,
  /** Max forward-raycast distance (meters) when auto-detecting the nearest window/glass plane at zone creation. Beyond this, no window is assumed to exist and only FORWARD_LIMIT (or its per-side override) applies. Kept at least as large as the largest FORWARD_LIMIT_BY_SIDE override so a real window within that whole range still gets detected and clamped. */
  WINDOW_DETECTION_MAX_DISTANCE_M: 7,
} as const;
