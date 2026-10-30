-- 0031_simplify_staging_rls.sql
--
-- Sederhanakan RLS untuk alur staging dan testing:
-- 1. rooms: izinkan user membaca room berstatus 'lobby' (agar join/pre-check room code lancar) atau room yang dia ikuti.
-- 2. room_players: izinkan user membaca roster room yang dia ikuti, dan izinkan update baris player milik sendiri.
-- 3. game_chat_messages: sederhanakan insert policy untuk anggota hidup tanpa nested current_player_id yang rawan desinkronisasi.
-- 4. Tabel rahasia (player_secrets, game_actions, game_action_results) tetap terkunci penuh untuk client-side.

-- 1. rooms read policy
drop policy if exists rooms_member_read on public.rooms;
create policy rooms_read on public.rooms
  for select to authenticated
  using (status = 'lobby' or is_room_member(id));

-- 2. room_players policies
drop policy if exists room_players_member_read on public.room_players;
create policy room_players_read on public.room_players
  for select to authenticated
  using (is_room_member(room_id));

drop policy if exists room_players_self_update on public.room_players;
create policy room_players_self_update on public.room_players
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 3. game_chat_messages insert policy
drop policy if exists game_chat_messages_alive_insert on public.game_chat_messages;
create policy game_chat_messages_insert on public.game_chat_messages
  for insert to authenticated
  with check (
    is_room_member(room_id) and is_alive_player_in_room(room_id)
  );
