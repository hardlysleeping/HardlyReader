-- What Supabase gives the schema before it is applied.
--
-- `supabase/schema.sql` is written for a Supabase project, so it references three
-- roles and one schema that a bare Postgres does not have: `anon`,
-- `authenticated` and `service_role` (its grants and revokes name them) and
-- `auth.users` (the foreign key from `entitlements.user_id`), and the three auth
-- tables the account layer keys on: `auth.sessions` (a device row is a session),
-- `auth.refresh_tokens` (what revoking ends) and `auth.identities` (the doors one
-- person has). A greenfield `postgres` container has none of them, so this file
-- supplies exactly those and nothing else — the suite is testing `schema.sql`,
-- not a copy of it.
--
-- This is fixture, not migration: it is applied by `tests/unit/billing-postgres.mjs`
-- in a throwaway container, and it is never part of what ships to Supabase.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text
);

-- Supabase grants `usage` on `auth` to the client roles, because every RLS policy
-- calls `auth.uid()` as the caller — and the account layer's policies and the
-- invoker-rights `register_device` read `auth.jwt()` the same way.
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- Supabase's `auth.uid()`, just enough of it for the RLS policy in schema.sql to
-- compile. Supabase reads the JWT claims the PostgREST request carries; here the
-- same claim is read from a session setting, so a test could impersonate a reader
-- if it ever wants to prove the policy refuses a write.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid;
$$;

grant execute on function auth.uid() to authenticated, anon, service_role;


-- The sessions a reader is signed in on. One row per sign-in; a device list row
-- is keyed by `id`, and the access token's `session_id` claim names it.
create table if not exists auth.sessions (
  id         uuid primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- What a refresh exchanges for a new access token. Deleting the session takes
-- these with it, which is why revoking is one delete.
create table if not exists auth.refresh_tokens (
  id         bigserial primary key,
  token      text,
  session_id uuid references auth.sessions (id) on delete cascade,
  revoked    boolean not null default false
);

-- The doors into one account: one row per provider, all under one user id. This
-- is the table that makes linking one account instead of two.
create table if not exists auth.identities (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  provider    text not null,
  provider_id text not null,
  unique (provider, provider_id)
);

grant select on auth.sessions, auth.refresh_tokens, auth.identities to service_role;

-- Supabase's `auth.jwt()`: the claims the PostgREST request carries. The policies
-- on `account_devices` and the register/revoke functions read `session_id` from
-- it, so a test sets the same setting `auth.uid()` already reads.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

grant execute on function auth.jwt() to authenticated, anon, service_role;
