-- 0037_realtime_private_channels.sql
--
-- Supabase Realtime Authorization (Private Channels):
-- Membatasi akses SELECT dan INSERT di realtime.messages hanya untuk anggota room (is_channel_member).
-- Non-member yang mencoba subscribe ke room:<roomId> dengan config: { private: true } akan ditolak oleh RLS.

create or replace function public.is_channel_member(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_room_id uuid;
begin
  if p_topic is null or not (p_topic like 'room:%') then
    return false;
  end if;

  begin
    v_room_id := substring(p_topic from 6)::uuid;
  exception when others then
    return false;
  end;

  return public.is_room_member(v_room_id);
end;
$$;

revoke all on function public.is_channel_member(text) from public, anon;
grant execute on function public.is_channel_member(text) to authenticated, service_role;

-- Pasang policy RLS pada realtime.messages (RLS sudah aktif bawaan Supabase)
drop policy if exists "room_channel_select" on "realtime"."messages";
create policy "room_channel_select"
on "realtime"."messages"
for select
to authenticated
using (
  public.is_channel_member(realtime.topic())
);

drop policy if exists "room_channel_insert" on "realtime"."messages";
create policy "room_channel_insert"
on "realtime"."messages"
for insert
to authenticated
with check (
  public.is_channel_member(realtime.topic())
);
