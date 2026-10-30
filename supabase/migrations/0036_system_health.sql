-- 0036_system_health.sql
--
-- Menyediakan fungsi get_system_health untuk endpoint /api/health
-- Mengembalikan status koneksi database, waktu terakhir cron pg_cron berjalan, dan jumlah migrasi terpasang.

create or replace function public.get_system_health()
returns jsonb
language plpgsql
security definer
set search_path = public, cron, supabase_migrations, pg_catalog
as $$
declare
  v_cron_last timestamptz;
  v_cron_status text;
  v_mig_count int := 0;
begin
  -- 1. Baca cron job terakhir
  begin
    select start_time, status into v_cron_last, v_cron_status
    from cron.job_run_details
    order by start_time desc
    limit 1;
  exception when others then
    v_cron_last := null;
    v_cron_status := 'unavailable';
  end;

  -- 2. Baca jumlah migrasi
  begin
    select count(*) into v_mig_count
    from supabase_migrations.schema_migrations;
  exception when others then
    v_mig_count := 0;
  end;

  return jsonb_build_object(
    'ok', true,
    'db', 'connected',
    'cron_last_run', v_cron_last,
    'cron_status', coalesce(v_cron_status, 'idle'),
    'migrations_count', v_mig_count
  );
exception when others then
  return jsonb_build_object(
    'ok', false,
    'db', 'error',
    'message', sqlerrm
  );
end;
$$;

revoke all on function public.get_system_health() from public, anon, authenticated;
grant execute on function public.get_system_health() to service_role;
