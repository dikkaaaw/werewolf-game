-- 0035_player_credentials_auth.sql
--
-- Desain Autentikasi Aman Berbasis Nickname + PIN:
-- 1. user_id adalah UUID acak asli (gen_random_uuid()), bukan turunan hash/HMAC.
-- 2. PIN di-hash dengan slow KDF (Bcrypt cost 10 via pgcrypto) di tabel player_credentials.
-- 3. Proteksi brute-force dengan exponential backoff per akun/nickname.
-- 4. Tabel player_credentials dikunci penuh dengan RLS (hanya service_role).

create table if not exists public.player_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null,
  nickname_normalized text not null unique,
  pin_hash text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.player_credentials enable row level security;
revoke all on public.player_credentials from public, anon, authenticated;
grant all on public.player_credentials to service_role;

-- RPC Verifikasi Login dengan Exponential Backoff
create or replace function public.verify_player_credentials(
  p_nickname text,
  p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_norm text;
  v_row public.player_credentials%rowtype;
  v_backoff_secs integer;
  v_email text;
begin
  v_norm := trim(lower(p_nickname));

  select * into v_row
  from public.player_credentials
  where nickname_normalized = v_norm
  for update;

  -- Akun belum terdaftar
  if not found then
    return jsonb_build_object('ok', true, 'found', false);
  end if;

  -- Cek apakah akun sedang terkunci karena salah PIN berulang kali
  if v_row.locked_until is not null and now() < v_row.locked_until then
    return jsonb_build_object(
      'ok', false,
      'found', true,
      'code', 'account_locked',
      'message', 'Akun terkunci sementara karena salah PIN berulang kali.',
      'retry_after', ceil(extract(epoch from (v_row.locked_until - now())))
    );
  end if;

  -- Verifikasi PIN via Bcrypt
  if extensions.crypt(p_pin, v_row.pin_hash) = v_row.pin_hash then
    -- Reset kegagalan saat berhasil
    update public.player_credentials
       set failed_attempts = 0,
           locked_until = null,
           updated_at = now()
     where user_id = v_row.user_id;

    -- Ambil email internal dari auth.users
    select email into v_email from auth.users where id = v_row.user_id;

    return jsonb_build_object(
      'ok', true,
      'found', true,
      'user_id', v_row.user_id,
      'email', v_email,
      'nickname', v_row.nickname
    );
  else
    -- PIN salah: naikkan failed_attempts dan hitung exponential backoff (2, 4, 8, 16, 32, ..., max 1800 detik)
    v_backoff_secs := least(1800, power(2, v_row.failed_attempts + 1)::integer);

    update public.player_credentials
       set failed_attempts = failed_attempts + 1,
           locked_until = now() + (v_backoff_secs * interval '1 second'),
           updated_at = now()
     where user_id = v_row.user_id;

    return jsonb_build_object(
      'ok', false,
      'found', true,
      'code', 'invalid_pin',
      'message', 'PIN salah untuk nickname ini.',
      'retry_after', v_backoff_secs
    );
  end if;
end;
$$;

-- RPC Pendaftaran Kredensial Baru dengan Bcrypt
create or replace function public.register_player_credentials(
  p_user_id uuid,
  p_nickname text,
  p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_norm text;
  v_hash text;
begin
  v_norm := trim(lower(p_nickname));

  -- Hash PIN dengan Bcrypt cost 10
  v_hash := extensions.crypt(p_pin, extensions.gen_salt('bf', 10));

  insert into public.player_credentials (
    user_id,
    nickname,
    nickname_normalized,
    pin_hash,
    failed_attempts,
    locked_until
  )
  values (
    p_user_id,
    trim(p_nickname),
    v_norm,
    v_hash,
    0,
    null
  );

  return jsonb_build_object('ok', true);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'nickname_taken', 'message', 'Nickname sudah digunakan.');
end;
$$;

revoke all on function public.verify_player_credentials(text, text) from public, anon, authenticated;
grant execute on function public.verify_player_credentials(text, text) to service_role;

revoke all on function public.register_player_credentials(uuid, text, text) from public, anon, authenticated;
grant execute on function public.register_player_credentials(uuid, text, text) to service_role;
