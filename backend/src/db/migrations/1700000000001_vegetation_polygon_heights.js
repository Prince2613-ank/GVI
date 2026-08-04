/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- ── gv_manual_vegetation_heights ────────────────────────────────────────
    -- Caches each manual vegetation polygon's resolved terrain elevation
    -- (Cesium.sampleTerrainMostDetailed — a real, tile-dependent network
    -- call) so it's computed ONCE across every visitor/browser, not once per
    -- browser's own localStorage (the previous, per-browser-only cache) and
    -- not once per page load. Keyed by (polygon_id, client_updated_at) —
    -- client_updated_at is the polygon's own updatedAt timestamp from the
    -- frontend, so editing a polygon's position naturally invalidates its
    -- cached height by simply no longer matching any stored row, without
    -- needing an explicit delete/update statement.
    create table if not exists gv_manual_vegetation_heights (
      polygon_id text not null,
      client_updated_at bigint not null,
      height_m double precision not null,
      resolved_at timestamptz not null default now(),
      primary key (polygon_id, client_updated_at)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table if exists gv_manual_vegetation_heights cascade;
  `);
};
