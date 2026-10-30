-- ===========================================================================
-- supabase/tests/rls_security_fixes.sql
--
-- Membuktikan 3 perbaikan keamanan RLS:
-- 1. User A tidak bisa mengupdate baris milik User B.
-- 2. User A tidak bisa memanipulasi kolom is_alive atau seat_number miliknya.
-- 3. Non-member tidak bisa membaca room privat.
-- ===========================================================================

do $$
declare
  v_user_a uuid := gen_random_uuid();
  v_user_b uuid := gen_random_uuid();
  v_user_c uuid := gen_random_uuid(); -- non-member
  v_room_id uuid;
  v_room_code text;
  v_player_a_id uuid;
  v_player_b_id uuid;
  v_res jsonb;
  v_count integer;
  v_blocked boolean;
begin
  -- 0. Buat user di auth.users
  insert into auth.users (id, email)
  values 
    (v_user_a, 'user_a_' || substr(gen_random_uuid()::text, 1, 8) || '@test.local'),
    (v_user_b, 'user_b_' || substr(gen_random_uuid()::text, 1, 8) || '@test.local'),
    (v_user_c, 'user_c_' || substr(gen_random_uuid()::text, 1, 8) || '@test.local');

  -- Buat room & join
  v_res := public.create_room(v_user_a, 'Player A', 10);
  v_room_id := (v_res->>'roomId')::uuid;
  v_room_code := v_res->>'roomCode';
  v_player_a_id := (v_res->>'playerId')::uuid;

  v_res := public.join_room(v_room_code, v_user_b, 'Player B');
  v_player_b_id := (v_res->>'playerId')::uuid;

  -- Kunci room jadi in_progress agar menjadi room privat
  update public.rooms set status = 'in_progress', phase = 'night', phase_ends_at = now() + interval '60 seconds'
  where id = v_room_id;

  -- -------------------------------------------------------------------------
  -- PENGUJIAN 1: User A tidak bisa update baris User B
  -- -------------------------------------------------------------------------
  -- Simulasikan session User A:
  set local role authenticated;
  execute format('set local "request.jwt.claims" = ''{"sub": "%s", "role": "authenticated"}''', v_user_a);

  -- Coba update baris User B dari session User A
  update public.room_players
     set is_ready = true
   where id = v_player_b_id;
  get diagnostics v_count = row_count;

  if v_count <> 0 then
    raise exception 'TEST FAILED: User A was able to update User B row! (row_count=%)', v_count;
  end if;
  raise notice 'PASS: User A cannot update User B row (0 rows updated)';

  -- -------------------------------------------------------------------------
  -- PENGUJIAN 2: User A tidak bisa mengubah is_alive atau seat_number miliknya
  -- -------------------------------------------------------------------------
  -- Coba update is_alive:
  v_blocked := false;
  begin
    update public.room_players
       set is_alive = false
     where id = v_player_a_id;
  exception when others then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'TEST FAILED: User A was able to change their own is_alive column!';
  end if;
  raise notice 'PASS: User A cannot change their own is_alive column (blocked by column privilege / trigger)';

  -- Coba update seat_number:
  v_blocked := false;
  begin
    update public.room_players
       set seat_number = 99
     where id = v_player_a_id;
  exception when others then
    v_blocked := true;
  end;

  if not v_blocked then
    raise exception 'TEST FAILED: User A was able to change their own seat_number!';
  end if;
  raise notice 'PASS: User A cannot change their own seat_number';

  -- User A BISA update is_ready miliknya sendiri:
  update public.room_players
     set is_ready = true
   where id = v_player_a_id;
  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'TEST FAILED: User A could not update their own is_ready status';
  end if;
  raise notice 'PASS: User A can legitimately update their own is_ready status';

  -- -------------------------------------------------------------------------
  -- PENGUJIAN 3: Non-member tidak bisa baca room privat
  -- -------------------------------------------------------------------------
  -- Simulasikan session User C (bukan anggota room ini):
  execute format('set local "request.jwt.claims" = ''{"sub": "%s", "role": "authenticated"}''', v_user_c);

  select count(*) into v_count from public.rooms where id = v_room_id;
  if v_count <> 0 then
    raise exception 'TEST FAILED: Non-member User C was able to select private room %!', v_room_id;
  end if;
  raise notice 'PASS: Non-member cannot select private room (0 rows returned)';

  select count(*) into v_count from public.room_players where room_id = v_room_id;
  if v_count <> 0 then
    raise exception 'TEST FAILED: Non-member User C was able to select roster of room %!', v_room_id;
  end if;
  raise notice 'PASS: Non-member cannot select roster of private room (0 rows returned)';

  reset role;
end $$;
