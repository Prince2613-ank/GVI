/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    alter table gv_wellness_snapshots
      add column if not exists air_quality_score numeric(5, 2) not null default 50,
      add column if not exists heat_comfort_score numeric(5, 2) not null default 50;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    alter table gv_wellness_snapshots
      drop column if exists air_quality_score,
      drop column if exists heat_comfort_score;
  `);
};
