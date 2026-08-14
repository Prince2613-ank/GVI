// Central constants for the GVI proof-of-concept demo.

// West Midtown Manhattan near the Hudson River. The point is intentionally
// outside park land so different facades see meaningfully different amounts
// of mapped trees, landscaped vegetation, water, roads, and buildings.
export const DEFAULT_LOCATION = {
  latitude: 40.7639,
  longitude: -73.9928303886457,
  height: -20,
};

// Texture-optimized build of the same model, produced by
// scripts/compress_building_textures.mjs: 25.8 MB -> 1.7 MB, identical
// geometry (92 meshes / 12,061 vertices / GPU instancing all preserved) —
// the original was 99.3% textures, eight of them 2048x2048, for a building
// that never occupies more than a few hundred pixels on screen. Beyond the
// download, this is also ~167 MB less GPU memory, since the driver expands
// textures to raw RGBA regardless of how well they compress on disk.
//
// hdsfds.glb (the original art) is kept as the source to regenerate from.
// Switch back to it if a texture ever looks too soft, or re-run the script
// with a larger --size.
export const BUILDING_MODEL_URL = "/models/hdsfds.opt.glb";

// The initial camera pose shown on page load: an oblique aerial view of the
// whole building and its street-level surroundings from the northeast,
// tilted down, instead of a flat straight-down top-down shot.
//
// This is an ORBIT pose (viewer.camera.lookAt / flyToBoundingSphere with a
// HeadingPitchRange), not a free camera position — rangeM is purely "how
// far back from the building," fully independent of headingDeg/pitchDeg
// ("which angle to view it from"). A free lon/lat/height pose used to be
// here instead; changing its implied distance from the building also
// silently changed how centered the building looked on screen (since a
// free pose isn't re-aimed at the building as it moves), which is why
// "pull back" and "zoom" felt tangled together — they're now the same,
// single, unambiguous rangeM control.
export const DEFAULT_VIEW = {
  rangeM: 648.57,
  headingDeg: 298.14,
  pitchDeg: -41.88,
};

export const FLOOR_HEIGHT_M = 4.6;
export const TOTAL_FLOORS = 10;
export const EYE_HEIGHT_M = 1.6;

// Distance the virtual camera is pushed outward from the building facade
// so it sits just outside the window glass instead of inside the wall mesh.
export const WINDOW_CAMERA_OFFSET_M = 0.5;

// Footprint half-extents and vertical base offset of the Atlanta office
// building GLB, measured directly from its glTF POSITION accessors (world
// transform applied) rather than guessed:
//   X extent ≈ 60.83m, Z extent (gltf, -> local "north/south") ≈ 96.85m,
//   Y extent (gltf, -> Cesium "up" after the Y-up->Z-up conversion Cesium
//   applies to every glTF model) ≈ 212m, with the model's lowest vertex
//   sitting 8.13m ABOVE the entity's origin (0,0,0) rather than at it.
// Previous placeholder values (20/15/0) put the window camera inside the
// building mass and measured floor height from the wrong ground plane —
// see MODEL_BASE_OFFSET_M below.
export const BUILDING_HALF_WIDTH_M = 30.42;
export const BUILDING_HALF_DEPTH_M = 48.43;

// The above two constants are for the Atlanta office GLB and don't match
// hdsfds.glb (BUILDING_MODEL_URL below) — the model actually rendered now.
// Rather than re-measure raw glTF accessors again (error-prone without
// walking the full node transform hierarchy), these are measured EMPIRICALLY
// from the real captured balcony viewpoints on all 4 facades (see
// features/balcony-debug/defaultBalconyViewpoints.json), rotated into the
// building's local frame the same way services/camera.ts positions the
// window camera: real half-extents came out to ~13.6m x ~23.8m at the
// live model's scale (1.55) — these are the base (scale=1) values, small
// safety margin included. Used only for the OSM-building site mask so a
// bug there can't also perturb the unrelated window-camera-pose feature
// that still relies on BUILDING_HALF_WIDTH_M/DEPTH_M above.
export const SITE_MASK_BASE_HALF_WIDTH_M = 9.5;
export const SITE_MASK_BASE_HALF_DEPTH_M = 16.5;

// Vertical distance from the entity's placement point (building.height) up
// to the model's actual visual base. All floor-height math must add this
// before it corresponds to a real point on the rendered mesh.
export const MODEL_BASE_OFFSET_M = 8.13;

// Trees/canopy polygons are only fetched and rendered within this radius of
// the building, so the merged corridor polygons stay a tight cluster around
// the placed model instead of pulling in vegetation from blocks away.
// Matches MAX_VISIBLE_RADIUS_M in useCesium.ts — the nearby-OSM-buildings
// render cap — so trees and buildings cover the same ~1km ground area
// instead of trees stopping noticeably short of where buildings still show.
export const VEGETATION_SEARCH_RADIUS_M = 1000;

// Building move threshold under which cached vegetation results are reused
// instead of re-querying the Overpass API (see STEP 13).
export const VEGETATION_CACHE_MOVE_THRESHOLD_M = 100;

// The primary instance rate-limits/times out often enough in practice that
// a bare single request regularly fails transiently. fetchVegetationRaw
// tries these in order, with retries, before giving up (see overpass.ts).
export const OVERPASS_API_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

// NYC Parks Forestry Management System tree points (updated every two weeks).
// It includes active street and landscaped-park trees, unlike the historical
// 2015 street-only census.
export const NYC_FORESTRY_TREE_API_URL =
  "https://data.cityofnewyork.us/resource/hn5i-inap.json";

export type CardinalDirection = "North" | "South" | "East" | "West";

export const CARDINAL_DIRECTIONS: CardinalDirection[] = [
  "North",
  "South",
  "East",
  "West",
];

// Heading (radians, clockwise from north) that a camera looks outward when
// standing at a window on each building facade, in the building's local frame.
export const DIRECTION_HEADING_RAD: Record<CardinalDirection, number> = {
  North: 0,
  East: Math.PI / 2,
  South: Math.PI,
  West: (3 * Math.PI) / 2,
};

export const VEGETATION_COLORS = {
  tree: "#2e7d32",
  street_tree: "#4caf50",
  wood: "#1b5e20",
  forest: "#0d3d10",
  park: "#66bb6a",
  scrub: "#8d9440",
  grassland: "#a5d6a7",
};

// Line-of-sight visibility analysis: for the currently selected floor, each
// nearby tree is ray-tested from the eye position to the tree's assumed
// canopy height, so obstructed trees (blocked by another building or this
// one) can be told apart from actually-visible ones — not just "within
// radius." Average mature NYC street tree canopy height; real per-species
// heights aren't in the census dataset, so this is a flat assumption.
export const TREE_CANOPY_HEIGHT_M = 8;

// Typical mature NYC street tree canopy spread radius (meters). Used both
// as the fallback single-tree circle radius and as the half-width of a
// merged street corridor strip (see services/treeCorridor.ts).
export const TREE_CANOPY_RADIUS_M = 3.5;

// Max gap (meters) between two trees for them to be considered part of the
// same street-tree row and merged into one corridor polygon. NYC street
// trees are typically planted every ~6-8m along a block; this is loose
// enough to bridge that spacing (and the odd missing/dead tree pit) while
// still splitting genuinely separate clusters — e.g. trees on either side
// of a wide intersection — into their own corridors.
export const TREE_CHAIN_LINK_DISTANCE_M = 12;

// A ray hit within this distance of the target still counts as "reaching"
// it (avoids false obstructions from floating-point/geometry noise right
// at the target itself, e.g. the tree's own canopy point).
export const LINE_OF_SIGHT_TOLERANCE_M = 3;

// Number of outward rays used to build the "eye sight" viewshed polygon
// (replaces a flat search-radius circle with the real unobstructed extent
// at the current eye height, per compass bearing).
export const VIEWSHED_RAY_COUNT = 20;

// Resolution of the screen-space viewshed mask used to restrict GVI scoring
// to the actual viewshed area (see services/visibility.ts's
// computeViewshedMask) rather than the entire captured photo. Each cell
// costs one real ray-pick; kept coarse (16x10 = 160 rays) to keep total
// per-capture ray count low — see VISIBILITY_MAX_TARGETS above.
export const VIEWSHED_MASK_GRID_COLS = 16;
export const VIEWSHED_MASK_GRID_ROWS = 10;

// Placeholder GVI classification (STEP 10), HSV hue-based rather than raw
// RGB channel-dominance. Plain "is green > red/blue by N" fails badly on
// hazy/atmosphere-lit scenes: sunlit or fog-desaturated grass often renders
// as an olive/khaki tone where R and G are nearly equal, so it never
// clears a fixed green-dominance margin even though it's unmistakably
// grass. Hue is far more robust to that kind of lighting/desaturation
// shift, since it tracks "greenness" independent of brightness/saturation.
export const GVI_GREEN_HSV_THRESHOLD = {
  minHueDeg: 55,
  maxHueDeg: 170,
  minSaturation: 0.12,
  minValue: 0.12,
  maxValue: 0.97,
};
