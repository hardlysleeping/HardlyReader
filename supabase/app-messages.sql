-- ── Messages: notes from the apps' author, read on demand ───────────────────
--
-- A message is one row the owner writes with the service key: an outage, a
-- promotion, "your lifetime upgrade is on the account". It is read by whoever it
-- was sent to, and nothing about it is intrusive: no push, no badge outside the
-- screen that lists it, and no reply path — a message is one-way on purpose.
--
-- The three rules, and each is a table decision rather than a client one:
--
-- 1. **A message names one app.** The same account is signed in to HardlyReader
--    and HardlyTracking, and an outage in one is noise in the other. `app` is
--    how the reader asks for its own list and never sees the other app's.
-- 2. **Targeting is a row, not a string.** `audience = 'all'` goes to every
--    account; `selected` goes to the rows in `app_message_recipients` and to
--    nobody else. One list is a list nobody can typo into a broadcast.
-- 3. **Read state is the reader's own row.** `app_message_reads` has no update
--    grant: marking a message read is an insert that cannot change an existing
--    answer, and an unread count is "a message I can see with no row here".
--
-- Neither table has a policy or a grant for `anon`/`authenticated`: the app only
-- ever calls the two functions below, so targeting and read state are decided in
-- one place, on the server, by `auth.uid()`.

create table if not exists public.app_messages (
  id            uuid primary key default gen_random_uuid(),
  -- Which app shows it. Two apps, one project, one account.
  app           text not null check (app in ('hardlyreader', 'hardlytracking')),
  title         text not null check (char_length(btrim(title)) between 1 and 120),
  body          text not null check (char_length(btrim(body)) between 1 and 4000),
  -- 'all' or 'selected'; 'selected' means the recipients table decides.
  audience      text not null default 'all' check (audience in ('all', 'selected')),
  -- A message written now but meant for later is published_at in the future.
  published_at  timestamptz not null default now(),
  -- Null is "until it is deleted"; a date is "stop showing it after this".
  expires_at    timestamptz,
  created_at    timestamptz not null default now()
);

comment on table public.app_messages is
  'One-way notes from the author to accounts, per app. Written with the service key only.';

create index if not exists app_messages_app_published
  on public.app_messages (app, published_at desc);

create table if not exists public.app_message_recipients (
  message_id  uuid not null references public.app_messages (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  primary key (message_id, user_id)
);

comment on table public.app_message_recipients is
  'Who a selected message goes to. Deleting the account deletes its rows.';

create table if not exists public.app_message_reads (
  message_id  uuid not null references public.app_messages (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  read_at     timestamptz not null default now(),
  primary key (message_id, user_id)
);

comment on table public.app_message_reads is
  'That a reader has seen a message. Insert-only: the first read is the only answer.';

alter table public.app_messages enable row level security;
alter table public.app_message_recipients enable row level security;
alter table public.app_message_reads enable row level security;

revoke all on public.app_messages from anon, authenticated;
revoke all on public.app_message_recipients from anon, authenticated;
revoke all on public.app_message_reads from anon, authenticated;

-- The service key is the only writer: it is what the sending tool holds, and no
-- build of either app does. Stated rather than inherited, so a project whose
-- default privileges differ still has exactly one role that can write.
grant select, insert, update, delete on public.app_messages to service_role;
grant select, insert, update, delete on public.app_message_recipients to service_role;
grant select, insert, update, delete on public.app_message_reads to service_role;

-- The reader's own list, newest first: what this app publishes to this account,
-- with the read state attached so one call answers both "what is there" and
-- "how many are unread". `security definer` because the tables have no grants;
-- `auth.uid()` is still the only thing deciding whose list this is.
create or replace function public.my_app_messages(p_app text)
returns table (
  id            uuid,
  app           text,
  title         text,
  body          text,
  published_at  timestamptz,
  read_at       timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.app, m.title, m.body, m.published_at, r.read_at
    from public.app_messages m
    left join public.app_message_reads r
      on r.message_id = m.id and r.user_id = auth.uid()
   where auth.uid() is not null
     and m.app = p_app
     and m.published_at <= now()
     and (m.expires_at is null or m.expires_at > now())
     and (
       m.audience = 'all'
       or exists (
         select 1 from public.app_message_recipients t
          where t.message_id = m.id and t.user_id = auth.uid()
       )
     )
   order by m.published_at desc
   limit 200;
$$;

comment on function public.my_app_messages(text) is
  'The calling account''s messages for one app, with read state. Nobody else''s rows can appear: auth.uid() is the filter.';

-- Marking read is an insert per message, and only for a message this account can
-- actually see. The array is the batch the screen just drew; anything else in it
-- is dropped rather than trusted. Returns how many were newly marked.
create or replace function public.mark_app_messages_read(p_app text, p_messages uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_marked  integer;
begin
  if v_user is null or p_messages is null then
    return 0;
  end if;

  with visible as (
    select m.id
      from public.app_messages m
     where m.id = any (p_messages)
       and m.app = p_app
       and m.published_at <= now()
       and (m.expires_at is null or m.expires_at > now())
       and (
         m.audience = 'all'
         or exists (
           select 1 from public.app_message_recipients t
            where t.message_id = m.id and t.user_id = v_user
         )
       )
  ), fresh as (
    insert into public.app_message_reads (message_id, user_id)
    select id, v_user from visible
    on conflict (message_id, user_id) do nothing
    returning 1
  )
  select count(*) into v_marked from fresh;

  return v_marked;
end;
$$;

comment on function public.mark_app_messages_read(text, uuid[]) is
  'Records that the caller has read these messages. Only messages in this app that the caller can see are accepted; repeats are ignored.';

revoke all on function public.my_app_messages(text) from public, anon;
revoke all on function public.mark_app_messages_read(text, uuid[]) from public, anon;
grant execute on function public.my_app_messages(text) to authenticated;
grant execute on function public.mark_app_messages_read(text, uuid[]) to authenticated;
