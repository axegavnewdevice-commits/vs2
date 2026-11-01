-- =====================================================================================
-- Arabic Scrabble: online multiplayer (2 players per private room)
--
-- Run this whole file once in  Supabase Dashboard -> SQL Editor -> New query -> Run
-- (or `supabase db push` if you use the Supabase CLI).  It is safe to run again.
--
-- Security model
--   * Browsers can NEVER write to these tables.  Every change goes through the Vercel
--     functions in /api, which use the service_role key (server-side only) and the
--     transactional functions below.
--   * Racks and the tile bag live in public.room_secrets.  That table has RLS enabled and
--     NO policy and NO grant for anon/authenticated, so no browser can ever read it.
--   * Members of a room may read that room's public_state and its two player rows (RLS).
--   * Realtime channels "room:<CODE>" are PRIVATE: only the two seated players can listen
--     or send (RLS on realtime.messages).  The server only broadcasts a tiny "changed" ping;
--     clients then fetch authoritative state over HTTPS, so forged broadcasts are harmless.
-- =====================================================================================

-- ---------- tables --------------------------------------------------------------------

create table if not exists public.rooms (
  id           uuid primary key default gen_random_uuid(),
  code         text not null,
  status       text not null default 'waiting' check (status in ('waiting', 'playing', 'closed')),
  version      integer not null default 0,          -- optimistic-lock counter, +1 on every change
  public_state jsonb   not null default '{}'::jsonb, -- board, scores, turn, clocks, history ... (no racks, no bag)
  created_by   uuid    not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  constraint rooms_code_format check (code ~ '^[A-Z0-9]{6}$')
);
create unique index if not exists rooms_code_key on public.rooms (code);
create index if not exists rooms_expires_idx on public.rooms (expires_at);
create index if not exists rooms_created_by_idx on public.rooms (created_by);

create table if not exists public.room_players (
  room_id   uuid     not null references public.rooms (id) on delete cascade,
  seat      smallint not null check (seat in (1, 2)),
  user_id   uuid     not null,                       -- auth.uid() of the (anonymous) Supabase user
  name      text,
  joined_at timestamptz not null default now(),
  primary key (room_id, seat),
  unique (room_id, user_id)                          -- one seat per person: nobody can take both
);
create index if not exists room_players_user_idx on public.room_players (user_id);

create table if not exists public.room_secrets (
  room_id uuid primary key references public.rooms (id) on delete cascade,
  state   jsonb not null                             -- full game: bag, both racks, board, clocks, ...
);

-- ---------- row level security -------------------------------------------------------

alter table public.rooms        enable row level security;
alter table public.room_players enable row level security;
alter table public.room_secrets enable row level security;

revoke all on public.rooms, public.room_players, public.room_secrets from anon, authenticated;
grant select on public.rooms, public.room_players to authenticated;   -- read-only, filtered by the policies below
-- room_secrets: deliberately NO grant and NO policy -> unreachable from any browser.

-- Helper used by the policies (SECURITY DEFINER avoids policy recursion on room_players).
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.room_players
    where room_id = p_room_id and user_id = (select auth.uid())
  );
$$;

create or replace function public.is_member_of_topic(p_topic text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.rooms r
    join public.room_players p on p.room_id = r.id
    where ('room:' || r.code) = p_topic
      and p.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_room_member(uuid)   from public, anon;
revoke all on function public.is_member_of_topic(text) from public, anon;
grant execute on function public.is_room_member(uuid)     to authenticated;
grant execute on function public.is_member_of_topic(text) to authenticated;

drop policy if exists "members can read their room" on public.rooms;
create policy "members can read their room" on public.rooms
  for select to authenticated
  using (public.is_room_member(id));

drop policy if exists "members can read the players of their room" on public.room_players;
create policy "members can read the players of their room" on public.room_players
  for select to authenticated
  using (public.is_room_member(room_id));

-- ---------- realtime authorization (private channels "room:<CODE>") -------------------
-- Broadcast + Presence: only the two seated players may receive or send on their room's topic.

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'realtime' and table_name = 'messages') then
    execute 'drop policy if exists "room members can receive" on realtime.messages';
    execute $p$
      create policy "room members can receive" on realtime.messages
        for select to authenticated
        using (
          realtime.messages.extension in ('broadcast', 'presence')
          and public.is_member_of_topic((select realtime.topic()))
        )
    $p$;
    execute 'drop policy if exists "room members can send" on realtime.messages';
    execute $p$
      create policy "room members can send" on realtime.messages
        for insert to authenticated
        with check (
          realtime.messages.extension in ('broadcast', 'presence')
          and public.is_member_of_topic((select realtime.topic()))
        )
    $p$;
  else
    raise notice 'realtime.messages not found: skipping realtime policies (they are created on Supabase projects).';
  end if;
end
$$;

-- ---------- transactional functions (service_role only) ------------------------------

-- Create a room and seat the creator as player 1, atomically.
create or replace function public.create_room(
  p_code    text,
  p_user    uuid,
  p_name    text,
  p_public  jsonb,
  p_state   jsonb,
  p_ttl     interval
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  -- a person only keeps one open waiting room: drop their older, never-joined ones
  delete from public.rooms where created_by = p_user and status = 'waiting';

  insert into public.rooms (code, status, version, public_state, created_by, expires_at)
  values (p_code, 'waiting', 0, p_public, p_user, now() + p_ttl)
  returning id into v_id;

  insert into public.room_players (room_id, seat, user_id, name) values (v_id, 1, p_user, p_name);
  insert into public.room_secrets (room_id, state) values (v_id, p_state);

  return jsonb_build_object('ok', true, 'room_id', v_id);
exception
  when unique_violation then
    return jsonb_build_object('error', 'code_taken');
end;
$$;

-- Take a seat.  The row lock serialises simultaneous joiners, so a third person can never get in.
create or replace function public.join_room(
  p_code text,
  p_user uuid,
  p_name text,
  p_ttl  interval
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  r      public.rooms%rowtype;
  v_seat smallint;
  v_cnt  integer;
begin
  select * into r from public.rooms where code = p_code for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if r.status = 'closed' then
    return jsonb_build_object('error', 'closed');
  end if;
  if r.expires_at <= now() then
    return jsonb_build_object('error', 'expired');
  end if;

  -- already seated (page refresh / reconnect): just hand the seat back
  select seat into v_seat from public.room_players where room_id = r.id and user_id = p_user;
  if found then
    return jsonb_build_object('ok', true, 'room_id', r.id, 'seat', v_seat, 'rejoined', true);
  end if;

  select count(*) into v_cnt from public.room_players where room_id = r.id;
  if v_cnt >= 2 then
    return jsonb_build_object('error', 'full');
  end if;

  insert into public.room_players (room_id, seat, user_id, name) values (r.id, 2, p_user, p_name);
  update public.rooms
     set status = 'playing', version = version + 1, updated_at = now(), expires_at = now() + p_ttl
   where id = r.id;

  return jsonb_build_object('ok', true, 'room_id', r.id, 'seat', 2, 'rejoined', false);
end;
$$;

-- Everything needed to serve a request, in one round trip.
create or replace function public.load_room(p_code text)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'room',    jsonb_build_object('id', r.id, 'code', r.code, 'status', r.status, 'version', r.version,
                                  'expires_at', r.expires_at, 'created_by', r.created_by),
    'players', coalesce((select jsonb_agg(jsonb_build_object('seat', p.seat, 'user_id', p.user_id, 'name', p.name) order by p.seat)
                           from public.room_players p where p.room_id = r.id), '[]'::jsonb),
    'state',   s.state
  )
  from public.rooms r
  join public.room_secrets s on s.room_id = r.id
  where r.code = p_code;
$$;

-- Optimistic-concurrency commit: succeeds only if nobody changed the room since it was loaded.
create or replace function public.commit_room(
  p_room_id          uuid,
  p_expected_version integer,
  p_status           text,
  p_public           jsonb,
  p_state            jsonb,
  p_ttl              interval
) returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_ver integer;
begin
  update public.rooms
     set version = version + 1, status = p_status, public_state = p_public,
         updated_at = now(), expires_at = now() + p_ttl
   where id = p_room_id and version = p_expected_version
  returning version into v_ver;

  if not found then
    return jsonb_build_object('error', 'conflict');
  end if;

  update public.room_secrets set state = p_state where room_id = p_room_id;
  return jsonb_build_object('ok', true, 'version', v_ver);
end;
$$;

-- Expired-room cleanup (called by the Vercel cron /api/cleanup and lazily when rooms are created).
create or replace function public.cleanup_expired_rooms()
returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  delete from public.rooms where expires_at < now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Only the server (service_role) may call the functions above.
revoke all on function public.create_room(text, uuid, text, jsonb, jsonb, interval) from public, anon, authenticated;
revoke all on function public.join_room(text, uuid, text, interval)                 from public, anon, authenticated;
revoke all on function public.load_room(text)                                       from public, anon, authenticated;
revoke all on function public.commit_room(uuid, integer, text, jsonb, jsonb, interval) from public, anon, authenticated;
revoke all on function public.cleanup_expired_rooms()                               from public, anon, authenticated;
grant execute on function public.create_room(text, uuid, text, jsonb, jsonb, interval) to service_role;
grant execute on function public.join_room(text, uuid, text, interval)                 to service_role;
grant execute on function public.load_room(text)                                       to service_role;
grant execute on function public.commit_room(uuid, integer, text, jsonb, jsonb, interval) to service_role;
grant execute on function public.cleanup_expired_rooms()                               to service_role;

-- ---------- optional: database-side cleanup every 30 minutes --------------------------
-- Enable the "pg_cron" extension (Dashboard -> Database -> Extensions), then run once:
--   select cron.schedule('scrabble-room-cleanup', '*/30 * * * *', $$select public.cleanup_expired_rooms()$$);
-- (The Vercel cron in vercel.json already cleans up daily, and expired rooms are also refused
--  everywhere, so this is only for tidiness.)
