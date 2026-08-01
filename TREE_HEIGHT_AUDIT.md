# Tree height data-flow audit

## Data flow

1. `LidarVegetationProvider` reads backend crown GeoJSON. `treeHeight` is the
   maximum CHM value produced by `backend/lidar/tree_metrics.py`; provenance is
   `LiDAR`.
2. If LiDAR is disabled, empty, or unavailable, `NYCStreetTreeProvider` reads
   the NYC 2015 Street Tree Census. The Census has DBH and species but no
   measured height, so it now requests `tree_dbh`, `spc_common`, and
   `spc_latin`.
3. `resolveTreeHeights` validates every individual tree. Census heights use a
   saturating DBH/species allometry and are marked `Estimated`. A tree lacking
   valid LiDAR height, DBH, and a recognized species receives the explicit
   8 m fallback and is marked `Default`; a console warning includes its ID.
4. `summarizeVegetation` reports LiDAR, estimated, default, and invalid counts.
5. `TreeRenderer` samples the active Cesium terrain provider at every tree,
   places the trunk base at that elevation, and sizes geometry so crown top is
   exactly `ground + treeHeight`. The first 20 placements are logged with ID,
   coordinates, ground, height, and provenance.
6. Window visibility uses each normalized `treeHeight` for the canopy target,
   rather than assigning one height to every tree.

Overpass currently contributes park/forest/wood/scrub/grassland geometry only;
it is not an individual-tree height source in this application.

## Findings fixed

- The Census request previously omitted DBH and supplied no height.
- Rendering and visibility silently used `8 m` through nullish fallbacks.
- Census trees were flat clamped ellipses rather than height-scaled 3D trees.
- LiDAR crown geometry reached 104% of `treeHeight`; it now reaches exactly
  100%.
- Missing and invalid heights were not reported.

Open the browser console and find `[Tree height]` / `[Tree placement]` for the
runtime audit table and warnings. The GVI panel displays aggregate provenance
counts.
