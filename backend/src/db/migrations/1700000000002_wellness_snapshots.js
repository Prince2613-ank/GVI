/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- ── gv_wellness_snapshots ────────────────────────────────────────────────
    -- One cached "Green Wellness Score" per building — a weighted combination
    -- of the existing per-window GVI average plus new environmental metrics
    -- (tree canopy density, nearest-park distance, an estimated noise level).
    -- Computed on a schedule (or on-demand with a max-age check), never
    -- recomputed synchronously on every GET /api/wellness/:buildingId request
    -- — external data sources (Overpass, NYC Forestry) are rate-limited and
    -- slow, the same reasoning the existing vegetation cache already follows.
    create table if not exists gv_wellness_snapshots (
      id uuid primary key default gen_random_uuid(),
      building_id uuid not null references gv_buildings(id) on delete cascade,
      overall_score numeric(5, 2) not null,
      green_view_score numeric(5, 2) not null,
      tree_canopy_score numeric(5, 2) not null,
      noise_score numeric(5, 2) not null,
      park_score numeric(5, 2) not null,
      raw_metrics jsonb not null,
      insights jsonb not null,
      recommendations jsonb not null,
      computed_at timestamptz not null default now()
    );

    create index if not exists gv_wellness_snapshots_building_id_idx
      on gv_wellness_snapshots (building_id, computed_at desc);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table if exists gv_wellness_snapshots cascade;
  `);
};
