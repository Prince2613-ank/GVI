import { BuildingTransform } from "../services/camera";
import { DEFAULT_LOCATION } from "../utils/constants";
import { degToRad } from "../utils/geo";

/**
 * The single hardcoded demo building's placement/transform — shared by the
 * interactive App and the automation capture harness (AutomationHarness.tsx)
 * so both compute the exact same camera poses for a given floor/direction.
 */
export const INITIAL_BUILDING: BuildingTransform = {
  latitude: DEFAULT_LOCATION.latitude,
  longitude: DEFAULT_LOCATION.longitude,
  height: DEFAULT_LOCATION.height,
  rotationRad: degToRad(120),
  scale: 1.55,
};
