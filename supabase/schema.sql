-- HardlyReader accounts and entitlements.
--
-- This is the entire backend: an identity, one boolean, and the column that says where the money
-- came from. The library — feeds, articles, read state, stars — never comes near this database.
--
-- Apply with `supabase db push`, or paste into the SQL editor of the project.
--
-- The one rule that matters: a client can READ its own entitlement and can never WRITE one.
-- `cloud_sync` is set by the payment webhook holding the service-role key, server-side.

create table if not exists public.entitlements (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  cloud_sync  boolean not null default false,
  -- 'stripe' today; 'apple' | 'google' if a store ever sells it. Never read by the app.
  source      text not null check (source in ('stripe', 'apple', 'google', 'manual')),
  expires_at  timestamptz,
  updated_at  timestamptz not null default now()
);

comment on table public.entitlements is
  'One row per reader who has ever owned HardlyReader Sync. Written by the payment webhook only.';

alter table public.entitlements enable row level security;

-- A reader may read their own row, and only their own.
drop policy if exists "read own entitlement" on public.entitlements;
create policy "read own entitlement"
  on public.entitlements
  for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert, update or delete policy is defined on purpose. With RLS enabled and no write policy,
-- every client-side write is refused — including a client that crafts a PATCH by hand. The webhook
-- uses the service-role key, which bypasses RLS.

-- Keep `updated_at` honest without trusting the writer.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists entitlements_touch on public.entitlements;
create trigger entitlements_touch
  before update on public.entitlements
  for each row execute function public.touch_updated_at();

-- Convenience for the webhook: one upsert, and it must never resurrect a cancelled row by accident.
-- `cloud_sync` is passed explicitly so an expiry sets false rather than leaving a stale true.
create or replace function public.set_entitlement(
  p_user uuid,
  p_cloud_sync boolean,
  p_source text,
  p_expires_at timestamptz
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.entitlements (user_id, cloud_sync, source, expires_at)
  values (p_user, p_cloud_sync, p_source, p_expires_at)
  on conflict (user_id) do update
    set cloud_sync = excluded.cloud_sync,
        source     = excluded.source,
        expires_at = excluded.expires_at;
$$;

-- Only the service role may call it: revoke from clients explicitly, since `security definer`
-- would otherwise let an authenticated user set their own flag by calling this directly.
revoke all on function public.set_entitlement(uuid, boolean, text, timestamptz) from public;
revoke all on function public.set_entitlement(uuid, boolean, text, timestamptz) from authenticated;
grant execute on function public.set_entitlement(uuid, boolean, text, timestamptz) to service_role;
