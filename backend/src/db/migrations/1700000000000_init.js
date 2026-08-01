/* eslint-disable camelcase */

exports.shorthands = undefined;

// Fixed, well-known id for the single demo building this service seeds —
// matches cesium-demo/src/config/building.ts's hardcoded INITIAL_BUILDING,
// so the frontend's Generation Control Panel can default to it without any
// building-picker UI.
const DEMO_BUILDING_ID = "00000000-0000-0000-0000-000000000001";
const TOTAL_FLOORS = 10;

exports.up = (pgm) => {
  pgm.sql(`
    create extension if not exists pgcrypto;

    do $$ begin
      create type gv_balcony_direction as enum ('North', 'South', 'East', 'West');
    exception when duplicate_object then null; end $$;

    do $$ begin
      create type gv_processing_job_status as enum (
        'pending', 'queued', 'rendering', 'capturing', 'analyzing', 'saving',
        'completed', 'failed'
      );
    exception when duplicate_object then null; end $$;

    create or replace function gv_set_updated_at()
    returns trigger
    language plpgsql
    as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$;

    -- ── gv_buildings ────────────────────────────────────────────────────────
    -- This service's OWN building/floor model, entirely separate from the
    -- other backend's dt_buildings/floors tables — same Postgres database,
    -- gv_-prefixed tables, zero shared rows or foreign keys across the two.
    create table if not exists gv_buildings (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      latitude double precision not null,
      longitude double precision not null,
      height double precision not null,
      rotation_rad double precision not null default 0,
      scale double precision not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create trigger gv_buildings_set_updated_at
      before update on gv_buildings
      for each row execute function gv_set_updated_at();

    -- ── gv_floors ───────────────────────────────────────────────────────────
    create table if not exists gv_floors (
      id uuid primary key default gen_random_uuid(),
      building_id uuid not null references gv_buildings(id) on delete cascade,
      floor_number int not null,
      name text not null,
      created_at timestamptz not null default now()
    );

    create unique index if not exists gv_floors_building_number_unique
      on gv_floors (building_id, floor_number);

    -- ── gv_viewpoints ───────────────────────────────────────────────────────
    create table if not exists gv_viewpoints (
      id uuid primary key default gen_random_uuid(),
      building_id uuid not null references gv_buildings(id) on delete cascade,
      floor_id uuid not null references gv_floors(id) on delete cascade,
      room text,
      direction gv_balcony_direction not null,
      flat_number int not null,
      longitude double precision not null,
      latitude double precision not null,
      height double precision not null,
      heading double precision not null default 0,
      pitch double precision not null default 0,
      roll double precision not null default 0,
      preview_image_path text,
      preview_captured_at timestamptz,
      gvi numeric(6, 5),
      green_pixels bigint,
      grey_pixels bigint,
      analysis_date timestamptz,
      status text not null default 'pending',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create unique index if not exists gv_viewpoints_slot_unique
      on gv_viewpoints (building_id, floor_id, direction, flat_number);

    create index if not exists gv_viewpoints_building_id_idx on gv_viewpoints (building_id);
    create index if not exists gv_viewpoints_floor_id_idx on gv_viewpoints (floor_id);
    create index if not exists gv_viewpoints_status_idx on gv_viewpoints (status);

    create trigger gv_viewpoints_set_updated_at
      before update on gv_viewpoints
      for each row execute function gv_set_updated_at();

    -- ── gv_captured_images ──────────────────────────────────────────────────
    create table if not exists gv_captured_images (
      id uuid primary key default gen_random_uuid(),
      viewpoint_id uuid not null references gv_viewpoints(id) on delete cascade,
      image_path text not null,
      width int not null,
      height int not null,
      content_type text not null default 'image/jpeg',
      byte_size int,
      captured_at timestamptz not null default now(),
      created_at timestamptz not null default now()
    );

    create index if not exists gv_captured_images_viewpoint_id_idx on gv_captured_images (viewpoint_id);
    create index if not exists gv_captured_images_captured_at_idx on gv_captured_images (captured_at desc);

    -- ── gv_gvi_results ───────────────────────────────────────────────────────
    create table if not exists gv_gvi_results (
      id uuid primary key default gen_random_uuid(),
      viewpoint_id uuid not null references gv_viewpoints(id) on delete cascade,
      captured_image_id uuid references gv_captured_images(id) on delete set null,
      gvi_score numeric(6, 5) not null,
      green_pixels bigint not null,
      grey_pixels bigint not null,
      total_pixels bigint not null,
      processing_time_ms int,
      thresholds_used jsonb,
      computed_at timestamptz not null default now()
    );

    create index if not exists gv_gvi_results_viewpoint_id_idx on gv_gvi_results (viewpoint_id);
    create index if not exists gv_gvi_results_computed_at_idx on gv_gvi_results (computed_at desc);

    -- ── gv_vegetation_masks ──────────────────────────────────────────────────
    create table if not exists gv_vegetation_masks (
      id uuid primary key default gen_random_uuid(),
      gvi_result_id uuid not null references gv_gvi_results(id) on delete cascade,
      mask_image_path text not null,
      pixel_count bigint not null,
      created_at timestamptz not null default now()
    );

    create index if not exists gv_vegetation_masks_gvi_result_id_idx on gv_vegetation_masks (gvi_result_id);

    -- ── gv_processing_jobs ───────────────────────────────────────────────────
    create table if not exists gv_processing_jobs (
      id uuid primary key default gen_random_uuid(),
      viewpoint_id uuid not null references gv_viewpoints(id) on delete cascade,
      status gv_processing_job_status not null default 'pending',
      attempt int not null default 0,
      max_attempts int not null default 3,
      error_message text,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index if not exists gv_processing_jobs_viewpoint_id_idx on gv_processing_jobs (viewpoint_id);
    create index if not exists gv_processing_jobs_status_idx on gv_processing_jobs (status);
    create index if not exists gv_processing_jobs_created_at_idx on gv_processing_jobs (created_at asc);

    create trigger gv_processing_jobs_set_updated_at
      before update on gv_processing_jobs
      for each row execute function gv_set_updated_at();

    -- ── Seed: the one demo building + its 10 floors ─────────────────────────
    -- Matches cesium-demo/src/config/building.ts's hardcoded INITIAL_BUILDING
    -- exactly, so the automation harness's own pose math and this service's
    -- stored geometry never disagree.
    insert into gv_buildings (id, name, latitude, longitude, height, rotation_rad, scale)
    values ('${DEMO_BUILDING_ID}', 'Green View Demo Building', 40.7639, -73.9928303886457, -20, 2.0943951023931953, 1.55)
    on conflict (id) do nothing;

    insert into gv_floors (building_id, floor_number, name)
    select '${DEMO_BUILDING_ID}', floor_number, 'Floor ' || floor_number
    from generate_series(1, ${TOTAL_FLOORS}) as floor_number
    on conflict (building_id, floor_number) do nothing;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table if exists gv_processing_jobs cascade;
    drop table if exists gv_vegetation_masks cascade;
    drop table if exists gv_gvi_results cascade;
    drop table if exists gv_captured_images cascade;
    drop table if exists gv_viewpoints cascade;
    drop table if exists gv_floors cascade;
    drop table if exists gv_buildings cascade;

    drop function if exists gv_set_updated_at();
    drop type if exists gv_processing_job_status;
    drop type if exists gv_balcony_direction;
  `);
};
