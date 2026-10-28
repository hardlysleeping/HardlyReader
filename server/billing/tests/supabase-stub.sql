-- What Supabase gives the schema before it is applied.
--
-- `supabase/schema.sql` is written for a Supabase project, so it references three
-- roles and one schema that a bare Postgres does not have: `anon`,
-- `authenticated` and `service_role` (its grants and revokes name them) and
-- `auth.users` (the foreign key from `entitlements.user_id`). A greenfield
-- `postgres` container has none of them, so this file supplies exactly those and
-- nothing else — the suite is testing `schema.sql`, not a copy of it.
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

grant usage on schema auth to service_role;
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
