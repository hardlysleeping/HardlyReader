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

-- The grant, stated rather than inherited. Supabase's default privileges hand
-- `authenticated` access to the public schema, and a policy on a table nobody was
-- granted is a policy that answers "permission denied" instead of "no rows". Say
-- it here so the promise holds on a project created with different defaults: one
-- table, read-only, one row's worth.
revoke all on public.entitlements from anon, authenticated;
grant select on public.entitlements to authenticated;

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

-- ─────────────────────────────────────────────────────────────────────────────
-- One person, one account: linking, the device list, and deletion.
--
-- Linking needs no table. `entitlements.user_id` is the auth user, so an identity
-- linked to that user — `linkIdentity` for Google or Apple, a confirmed email
-- change for an address — leaves the id alone and the entitlement row is the same
-- row it was before. That is the whole guarantee: one `auth.users` row, one
-- `cloud_sync`, one subscription, whichever door the reader came through.
--
-- What must never happen is a *second* `auth.users` row for the same person, so
-- the app links while signed in and refuses a second sign-in
-- (`src/api/identity.ts`). The other half is a project setting, not SQL: turn on
-- Authentication → "Link identities with the same email" (automatic linking), so
-- a reader who signs in with Apple after paying with Google lands on the account
-- that already owns Sync instead of being told they have no subscription.
--
-- ── The devices this account is signed in on ────────────────────────────────
--
-- One row per *session*, not per device that ever installed the app: the key is
-- the `auth.sessions` row, which is the id in the access token's `session_id`
-- claim. Signing out ends the session and the row goes with it, and revoking is
-- the same deletion from the other side. Nothing here holds a library, a feed or
-- a file name.

create table if not exists public.account_devices (
  session_id   uuid primary key references auth.sessions (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  label        text not null default '',
  platform     text not null default '',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

comment on table public.account_devices is
  'The sessions this account is signed in on, for the device list. Keyed by a session: sign out or revoke, and the row is gone.';

alter table public.account_devices enable row level security;

drop policy if exists "read own devices" on public.account_devices;
create policy "read own devices"
  on public.account_devices
  for select
  to authenticated
  using (user_id = auth.uid());

-- A device may register itself, and only itself: the row's primary key has to be
-- the session in the caller's own token, so no client can add a row for a session
-- it does not hold.
drop policy if exists "register own session" on public.account_devices;
create policy "register own session"
  on public.account_devices
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and session_id = (auth.jwt() ->> 'session_id')::uuid
  );

drop policy if exists "touch own session" on public.account_devices;
create policy "touch own session"
  on public.account_devices
  for update
  to authenticated
  using (
    user_id = auth.uid()
    and session_id = (auth.jwt() ->> 'session_id')::uuid
  )
  with check (
    user_id = auth.uid()
    and session_id = (auth.jwt() ->> 'session_id')::uuid
  );

revoke all on public.account_devices from anon, authenticated;
grant select, insert, update on public.account_devices to authenticated;
-- No delete policy, and no delete grant: a device leaves the list by ending its
-- session, which is the thing that actually signs it out. A client that could
-- delete a row directly could hide a device that is still signed in.

-- "This device is here." Idempotent by session, so a second launch updates the
-- label instead of adding a device. Runs as the caller: the policies above are
-- what make it safe, so it needs no `security definer` at all.
create or replace function public.register_device(p_label text, p_platform text)
returns uuid
language plpgsql
as $$
declare
  v_session uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
begin
  if auth.uid() is null or v_session is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  insert into public.account_devices (session_id, user_id, label, platform)
  values (v_session, auth.uid(), coalesce(p_label, ''), coalesce(p_platform, ''))
  on conflict (session_id) do update
    set label = excluded.label,
        platform = excluded.platform,
        last_seen_at = now();

  return v_session;
end;
$$;

comment on function public.register_device(text, text) is
  'Registers this device''s own session for the device list. The session id comes from the token, never from an argument.';

revoke all on function public.register_device(text, text) from public, anon;
grant execute on function public.register_device(text, text) to authenticated;

-- ── Revoking one device ─────────────────────────────────────────────────────
--
-- The session is the credential, so ending it is the revocation: the refresh
-- tokens for that session go with it, and the device's next refresh fails, which
-- the app already turns into "signed out, library untouched". The access token it
-- already holds stays valid until it expires — that is what a stateless JWT is —
-- and nothing in this app acts on one without asking the server first.
--
-- `auth.sessions` is not writable by a client, which is why this is a definer
-- function; `auth.uid()` and the user check are what stop it ending anybody
-- else's. It touches no library, no entitlement, and no provider file: there is
-- nothing of those in this database to touch.

create or replace function public.revoke_device(p_session uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_ended integer := 0;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  -- Explicit rather than relying on the cascade, because "this device can no
  -- longer refresh" is the promise, and a reader of this function should see it.
  delete from auth.refresh_tokens
   where session_id = p_session
     and session_id in (select id from auth.sessions where id = p_session and user_id = v_user);

  delete from auth.sessions
   where id = p_session
     and user_id = v_user;
  get diagnostics v_ended = row_count;

  return v_ended > 0;
end;
$$;

comment on function public.revoke_device(uuid) is
  'Ends one of the caller''s own sessions. The device signs out on its next refresh; nothing is deleted from a library.';

revoke all on function public.revoke_device(uuid) from public, anon;
grant execute on function public.revoke_device(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Stripe: which customer is which reader, and every event already applied.
--
-- The row above answers "does this reader own Sync". These two answer the two
-- questions a webhook must never answer from its own body:
--
--   * `stripe_customers` is the link. It is written once, at checkout creation,
--     by a request that carried the reader's JWT — never by a webhook. A webhook
--     body can name any customer id, and a customer id that came from the body
--     is an attacker's claim about which account to grant.
--   * `stripe_events` is the memory. Stripe delivers at least once and out of
--     order, so an event id has to be spent exactly once, and an event older
--     than what has already been applied must not win.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.stripe_customers (
  -- One customer per reader: a second purchase reuses the customer, so someone
  -- who cancels and resubscribes does not end up with two identities at Stripe.
  user_id            uuid primary key references auth.users (id) on delete cascade,
  customer_id        text not null unique,
  -- The newest `event.created` applied for this customer. Anything older is a
  -- late delivery, and applying it is exactly how a cancelled row comes back.
  last_event_created bigint not null default 0,
  created_at         timestamptz not null default now()
);

comment on table public.stripe_customers is
  'Stripe customer to reader. Written at checkout creation with the reader''s JWT; read by the webhook.';

alter table public.stripe_customers enable row level security;
-- No policies at all: not readable and not writable by any client. The service
-- role bypasses RLS; the app has no business knowing its customer id.

create table if not exists public.stripe_events (
  id          text primary key,
  type        text not null,
  created     bigint not null,
  customer_id text,
  user_id     uuid,
  -- claimed → applied | duplicate | stale | unknown_customer | kept_other_source
  outcome     text not null default 'claimed',
  received_at timestamptz not null default now(),
  applied_at  timestamptz
);

comment on table public.stripe_events is
  'Every Stripe event id ever seen, so a replay is a no-op. Service role only.';

alter table public.stripe_events enable row level security;
-- No policies: service role only.

create index if not exists stripe_events_customer_idx
  on public.stripe_events (customer_id, created desc);

-- One transaction: spend the event id, refuse an unknown customer, refuse a late
-- delivery, write the row. The webhook orchestrates none of this — three round
-- trips would leave a window where a crash loses a grant or a replay doubles it.
create or replace function public.apply_stripe_event(
  p_event_id      text,
  p_event_type    text,
  p_event_created bigint,
  p_customer      text,
  p_cloud_sync    boolean,
  p_expires_at    timestamptz
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user      uuid;
  v_watermark bigint;
  v_applied   timestamptz;
  v_source    text;
  v_current   boolean;
begin
  -- 1. Spend the id. A conflict means this event has been seen; whether it was
  --    finished decides between "replay" and "the last attempt died midway".
  insert into public.stripe_events (id, type, created, customer_id)
  values (p_event_id, p_event_type, p_event_created, p_customer)
  on conflict (id) do nothing;

  if not found then
    select applied_at into v_applied
      from public.stripe_events
     where id = p_event_id
       for update;
    if v_applied is not null then
      return 'duplicate';
    end if;
    -- Claimed but never finished: fall through and apply it. `set_entitlement`
    -- is one upsert, so finishing twice writes the same row twice.
  end if;

  -- 2. The customer decides the reader. Never a field in the event body.
  select user_id, last_event_created into v_user, v_watermark
    from public.stripe_customers
   where customer_id = p_customer
     for update;

  if not found then
    update public.stripe_events
       set outcome = 'unknown_customer', applied_at = now()
     where id = p_event_id;
    return 'unknown_customer';
  end if;

  -- 3. A late delivery must not resurrect what a newer event already ended.
  if p_event_created < v_watermark then
    update public.stripe_events
       set outcome = 'stale', applied_at = now(), user_id = v_user
     where id = p_event_id;
    return 'stale';
  end if;

  -- 4. A row another shop wrote is not this webhook's to revoke: if a store ever
  --    sells the same capability, a cancelled Stripe subscription must not
  --    cancel an Apple purchase.
  select source, cloud_sync into v_source, v_current
    from public.entitlements
   where user_id = v_user;

  if v_source is not null and v_source <> 'stripe' and v_current is true and p_cloud_sync is false then
    update public.stripe_events
       set outcome = 'kept_other_source', applied_at = now(), user_id = v_user
     where id = p_event_id;
    return 'kept_other_source';
  end if;

  -- 5. The one write the whole feature exists for.
  perform public.set_entitlement(v_user, p_cloud_sync, 'stripe', p_expires_at);

  update public.stripe_customers
     set last_event_created = greatest(last_event_created, p_event_created)
   where customer_id = p_customer;

  update public.stripe_events
     set outcome = 'applied', applied_at = now(), user_id = v_user
   where id = p_event_id;

  return 'applied';
end;
$$;

comment on function public.apply_stripe_event(text, text, bigint, text, boolean, timestamptz) is
  'Idempotent by event id, ordered by event.created, keyed by the checkout-time customer link.';

revoke all on function public.apply_stripe_event(text, text, bigint, text, boolean, timestamptz) from public;
revoke all on function public.apply_stripe_event(text, text, bigint, text, boolean, timestamptz) from authenticated;
grant execute on function public.apply_stripe_event(text, text, bigint, text, boolean, timestamptz) to service_role;

-- ── Deleting the account ────────────────────────────────────────────────────
--
-- The cascade in the first table of this file is the whole of it: delete the
-- `auth.users` row and `entitlements` and `stripe_customers` go with it, along
-- with the sessions (and therefore the device rows). The reader's library is on
-- their device and their files are in their own cloud folder; neither is in this
-- database, so neither can be reached from here — which is the trap this function
-- exists to keep shut.
--
-- It refuses while money is still moving. Deleting an identity that Stripe is
-- still charging leaves a card charging for an account no webhook can name, so the
-- reader cancels first, at the payment provider, and comes back. `manual` is a
-- grant with no money behind it, so it does not block.

create or replace function public.delete_my_account()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_active  boolean;
  v_source  text;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  select cloud_sync, source into v_active, v_source
    from public.entitlements
   where user_id = v_user;

  if v_active is true and v_source in ('stripe', 'apple', 'google') then
    return 'cancel_first';
  end if;

  -- The ledger keeps the money, and loses the person: an event row is the record
  -- of a charge, not a name, and it is the service role's table either way.
  update public.stripe_events set user_id = null where user_id = v_user;

  delete from auth.users where id = v_user;
  return 'deleted';
end;
$$;

comment on function public.delete_my_account() is
  'Deletes the caller''s own identity, entitlement and sessions. Never a library, never a provider file. Refuses while a paid subscription is still charging.';

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
