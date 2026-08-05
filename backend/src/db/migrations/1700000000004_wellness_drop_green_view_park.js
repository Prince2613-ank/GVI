/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- Green View and Park Accessibility removed from the active wellness
    -- score (per explicit request) — GVI is a per-window metric that
    -- doesn't represent "the building" as one number the way the other
    -- five site-level metrics do, and Park Accessibility is dropped in
    -- favor of a richer, multi-source Tree Canopy metric instead. Columns
    -- are kept (not dropped) for backward compatibility with any existing
    -- snapshot rows — just defaulted to 0 so new inserts can omit them.
    alter table gv_wellness_snapshots
      alter column green_view_score set default 0,
      alter column park_score set default 0;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    alter table gv_wellness_snapshots
      alter column green_view_score drop default,
      alter column park_score drop default;
  `);
};
