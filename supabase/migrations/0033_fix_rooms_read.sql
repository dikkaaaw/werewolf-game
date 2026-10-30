-- 0033_fix_rooms_read.sql
--
-- Mengunci kembali pembacaan tabel rooms agar strictly member-only.
-- Non-member tidak bisa membaca detail kamar privat atau mengintip status lobby via client-side.
-- Join room dilakukan secara otoritatif oleh service-role RPC join_room.

drop policy if exists rooms_read on public.rooms;
drop policy if exists rooms_member_read on public.rooms;

create policy rooms_member_read on public.rooms
  for select to authenticated
  using (is_room_member(id));
