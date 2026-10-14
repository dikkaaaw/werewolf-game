-- ===========================================================================
-- supabase/tests/harness.sql — LOCAL/CI TEST HARNESS ONLY
--
-- *** This file is NOT a migration and must never run against production. ***
--
-- The migrations in ../migrations/ are written for Supabase, which provides an
-- `auth` schema, `auth.uid()`, and the `anon` / `authenticated` / `service_role`
-- roles out of the box. A bare Postgres instance has none of that, so this file
-- stands up a faithful-enough stub to exercise the migrations for real.
--
-- What it fakes:
--   * auth.users          — the user table the FKs point at
--   * auth.uid()          — reads the JWT `sub` claim, exactly as Supabase does,
--                           so `set local request.jwt.claim.sub = ...` can
--                           impersonate a user in RLS tests
--   * anon / authenticated / service_role roles
--   * service_role        — BYPASSRLS, matching Supabase
--   * supabase_realtime   — the publication 0002_rls.sql attaches tables to
--   * extensions schema   — Supabase installs pgcrypto there, and
--                           `public.create_room` calls `extensions.gen_random_bytes(1)`
--                           with an explicit `search_path`. Without this schema
--                           the room-creation RPC cannot even run locally, so the
--                           whole suite dead-ends at setup. Mirrored here so the
--                           local database matches the hosted shape the
--                           migrations are written against.
--
-- Usage:
--   psql -h 127.0.0.1 -p 55432 -U postgres -d werewolf_test \
--        -f supabase/tests/harness.sql
-- ===========================================================================

-- --- extensions schema + pgcrypto ------------------------------------------
-- Supabase places pgcrypto in `extensions`, not `public`. Migration 0004
-- depends on that exact qualification, so the stub has to match.
create schema if not exists extensions;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
    create extension if not exists pgcrypto with schema extensions;
  end if;
end $$;

-- Supabase additionally exposes these from `extensions`; provide them if the
-- local install did not place them there.
do $$
begin
  if to_regprocedure('extensions.gen_random_bytes(integer)') is null
     and to_regprocedure('pg_catalog.gen_random_bytes(integer)') is not null then
    execute 'create or replace function extensions.gen_random_bytes(integer)
             returns bytea as $f$ select pg_catalog.gen_random_bytes($1) $f$ language sql';
  end if;
  if to_regprocedure('extensions.gen_random_uuid()') is null
     and to_regprocedure('pg_catalog.gen_random_uuid()') is not null then
    execute 'create or replace function extensions.gen_random_uuid()
             returns uuid as $f$ select pg_catalog.gen_random_uuid() $f$ language sql';
  end if;
end $$;

-- --- Roles ------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- Supabase grants service_role BYPASSRLS; matching it here is essential,
    -- otherwise the server code path would behave differently under test.
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

-- --- auth schema ------------------------------------------------------------
create schema if not exists auth;

create table if not exists auth.users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique,
  created_at timestamptz not null default now()
);

-- Mirrors Supabase's definition: prefer the legacy `sub` claim, fall back to
-- the combined `claims` JSON.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    ),
    ''
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- --- realtime publication ---------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- --- test users -------------------------------------------------------------
-- Fixed UUIDs so tests and docs can reference them.
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'host@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'alice@example.test'),
  ('33333333-3333-3333-3333-333333333333', 'bob@example.test'),
  ('44444444-4444-4444-4444-444444444444', 'carol@example.test'),
  ('55555555-5555-5555-5555-555555555555', 'dave@example.test'),
  ('66666666-6666-6666-6666-666666666666', 'eve@example.test'),
  ('99999999-9999-9999-9999-999999999999', 'outsider@example.test')
on conflict (id) do nothing;
